/**
 * BANC DE MESURE DU CACHE DE LECTURE.
 *
 * Compare, sur les VRAIES données de production, ce que coûtaient les lectures
 * d'un envoi de message avant Redis et ce qu'elles coûtent maintenant.
 *
 * Lancement :
 *   node --env-file=.env scripts/mesure-cache.mjs
 *
 * 🔴 N'ÉCRIT RIEN EN BASE. Uniquement des `findUnique` / `findMany`. Il remplit
 * le cache Redis, ce que le moindre message fait déjà.
 *
 * ⚠️ N'AFFICHE AUCUNE DONNÉE PERSONNELLE : ni nom, ni numéro, ni identifiant
 * complet. Que des durées et des comptes.
 *
 * ⚠️ MESURER PAR L'INTERFACE NE PROUVERAIT RIEN. Le temps y serait noyé dans le
 * réseau, le rendu du navigateur et la qualité de la connexion — trois choses
 * bien plus lentes et bien plus variables que ce qu'on cherche à mesurer. Ici on
 * mesure exactement les requêtes que le cache a supprimées, et rien d'autre.
 */
import { PrismaClient } from "@prisma/client";
import {
  metaConversation,
  membresConversation,
  profilCache,
} from "../src/lib/cache-redis.mjs";
import { redis, fermerRedis } from "../src/lib/redis-client.mjs";

const prisma = new PrismaClient();

const COLD = 30; // itérations en base directe
const WARM = 300; // itérations sur cache chaud (bien plus rapides)

/** Médiane et 95e centile d'une série de durées, en millisecondes. */
async function mesurer(fn, n) {
  const t = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    t.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  t.sort((a, b) => a - b);
  return {
    median: t[Math.floor(t.length / 2)],
    p95: t[Math.floor(t.length * 0.95)],
    total: t.reduce((a, b) => a + b, 0),
  };
}

const ms = (x) => `${x.toFixed(2)} ms`;
const ligne = (nom, a, b) => {
  const gain = a.median > 0 ? a.median / Math.max(b.median, 0.0001) : 0;
  console.log(
    `  ${nom.padEnd(34)} ${ms(a.median).padStart(10)} ${ms(b.median).padStart(10)}   ×${gain.toFixed(0)}`,
  );
};

async function main() {
  const c = redis();
  if (!c) {
    console.log("REDIS_URL absente : rien à mesurer.");
    return;
  }
  if (c.status !== "ready") {
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("Redis pas prêt en 5 s")), 5000);
      c.once("ready", () => {
        clearTimeout(t);
        res();
      });
    });
  }

  // La conversation la plus vivante : c'est celle qui profite le plus du cache,
  // et celle dont le comportement compte vraiment.
  const conv = await prisma.conversation.findFirst({
    where: { lastMessageAt: { not: null } },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true, isGroup: true, _count: { select: { participants: true } } },
  });
  if (!conv) {
    console.log("Aucune conversation avec des messages : rien à mesurer.");
    return;
  }

  const membres = await prisma.participant.findMany({
    where: { convId: conv.id },
    select: { userId: true },
  });
  const expediteur = membres[0]?.userId;
  if (!expediteur) {
    console.log("Conversation sans participant : rien à mesurer.");
    return;
  }

  console.log(`\nConversation mesurée : ${conv.isGroup ? "groupe" : "tête-à-tête"}, ${conv._count.participants} participant(s)`);
  console.log(`Itérations : ${COLD} en base directe, ${WARM} sur cache chaud\n`);

  /* ── Les trois lectures, une par une ─────────────────────────────────── */

  // Cache chaud avant de chronométrer : on mesure le régime permanent, pas le
  // premier appel, qui descend forcément en base.
  await metaConversation(prisma, conv.id);
  await membresConversation(prisma, conv.id);
  await profilCache(prisma, expediteur);

  const metaBase = await mesurer(
    () =>
      prisma.conversation.findUnique({
        where: { id: conv.id },
        select: { isGroup: true, disappearingSeconds: true },
      }),
    COLD,
  );
  const metaCache = await mesurer(() => metaConversation(prisma, conv.id), WARM);

  const membresBase = await mesurer(
    () => prisma.participant.findMany({ where: { convId: conv.id }, select: { userId: true } }),
    COLD,
  );
  const membresCache = await mesurer(() => membresConversation(prisma, conv.id), WARM);

  const profilBase = await mesurer(
    () => prisma.user.findUnique({ where: { id: expediteur } }),
    COLD,
  );
  const profilCacheM = await mesurer(() => profilCache(prisma, expediteur), WARM);

  console.log("Lecture par lecture");
  console.log(`  ${"".padEnd(34)} ${"base".padStart(10)} ${"cache".padStart(10)}`);
  ligne("métadonnées de conversation", metaBase, metaCache);
  ligne("liste des membres", membresBase, membresCache);
  ligne("profil de l'expéditeur", profilBase, profilCacheM);

  /* ── L'envoi d'un message, avant et après ────────────────────────────── */

  /**
   * Les lectures que faisait `handleSend` AVANT, dans l'ordre exact : la
   * conversation trois fois (une pour l'expiration, deux pour `isGroup`), les
   * participants, l'appartenance de l'expéditeur, sa ligne ENTIÈRE, puis la
   * conversation avec la fiche complète de chaque membre.
   */
  const avant = async () => {
    await prisma.participant.findUnique({
      where: { convId_userId: { convId: conv.id, userId: expediteur } },
      select: { id: true },
    });
    await prisma.participant.findMany({ where: { convId: conv.id }, select: { userId: true } });
    await prisma.conversation.findUnique({
      where: { id: conv.id },
      select: { disappearingSeconds: true },
    });
    await prisma.conversation.findUnique({ where: { id: conv.id }, select: { isGroup: true } });
    await prisma.conversation.findUnique({ where: { id: conv.id }, select: { isGroup: true } });
    await prisma.user.findUnique({ where: { id: expediteur } });
    await prisma.conversation.findUnique({
      where: { id: conv.id },
      include: { participants: { include: { user: true } } },
    });
  };

  /** Les mêmes besoins aujourd'hui : trois viennent du cache, une reste en base. */
  const apres = async () => {
    await membresConversation(prisma, conv.id); // sert aussi l'appartenance
    await metaConversation(prisma, conv.id);
    await profilCache(prisma, expediteur);
    await prisma.conversation.findUnique({
      where: { id: conv.id },
      select: {
        name: true,
        isGroup: true,
        participants: { select: { userId: true, sourdine: true } },
      },
    });
  };

  const a = await mesurer(avant, COLD);
  const b = await mesurer(apres, COLD);

  console.log("\nToutes les lectures d'UN envoi de message");
  console.log(`  avant Redis (7 requêtes)           ${ms(a.median).padStart(10)}   p95 ${ms(a.p95)}`);
  console.log(`  aujourd'hui (1 requête + 3 caches) ${ms(b.median).padStart(10)}   p95 ${ms(b.p95)}`);
  console.log(
    `  → ${ms(a.median - b.median)} de moins par message, soit ×${(a.median / Math.max(b.median, 0.0001)).toFixed(1)} plus rapide`,
  );

  /* ── Ce que Redis a réellement évité depuis son démarrage ───────────── */

  const stats = await c.info("stats");
  const lire = (champ) => {
    const m = stats.match(new RegExp(`^${champ}:(\\d+)`, "m"));
    return m ? Number(m[1]) : 0;
  };
  const hits = lire("keyspace_hits");
  const misses = lire("keyspace_misses");
  const total = hits + misses;

  console.log("\nDepuis le démarrage de Redis");
  console.log(`  lectures servies par le cache : ${hits}`);
  console.log(`  lectures descendues en base   : ${misses}`);
  if (total > 0) {
    console.log(`  taux de succès                : ${((hits / total) * 100).toFixed(1)} %`);
    // Économie estimée avec le coût médian réellement mesuré ci-dessus, pas une
    // valeur théorique.
    const coutMoyen = (metaBase.median + membresBase.median + profilBase.median) / 3;
    console.log(`  temps de base économisé       : ~${(hits * coutMoyen).toFixed(0)} ms au total`);
  } else {
    console.log("  (aucun trafic encore : envoie quelques messages puis relance)");
  }
  console.log();
}

main()
  .catch((e) => {
    console.error("mesure interrompue :", e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await fermerRedis();
  });
