import { setDefaultResultOrder } from "node:dns";
import { env } from "@/lib/env";
import { ErreurAdmin } from "./reponses";

/**
 * L'ASSISTANCE ÉDITORIALE de la console (lot 1d, 16/10/2026) : traduire et
 * relire les textes officiels — diffusions, bienvenue — AVANT publication.
 *
 * Même modèle et même clé que l'assistant de l'application (`assistant.ts`) ;
 * sans clé, la console masque ses boutons (`enabled: false`).
 *
 * ⚠️ ELLE N'ÉCRIT RIEN : elle propose, l'administrateur décide. Rien de ce
 * qu'elle rend n'est publié sans passer par l'éditeur.
 *
 * ⚠️ IPv4 D'ABORD, comme `assistant.ts` : l'IPv6 du VPS est refusée par le
 * fournisseur (« User location is not supported », diagnostiqué le 25/08).
 */
setDefaultResultOrder("ipv4first");

const NATURES: Record<string, string> = {
  welcome: "un message de bienvenue envoyé à un nouvel utilisateur de la messagerie Alanya Work",
  broadcast: "une annonce officielle envoyée par Alanya Work à une partie des utilisateurs",
  status: "un statut court publié par le compte officiel",
  cta: "un libellé de bouton, très court",
};

const LANGUES: Record<string, string> = { fr: "français", en: "anglais", zh: "chinois simplifié" };

export function etatIa() {
  return { enabled: !!env.assistant.apiKey, model: env.assistant.apiKey ? env.assistant.model : null };
}

async function demander<T>(consigne: string, contenu: string): Promise<T> {
  const cle = env.assistant.apiKey;
  if (!cle) throw new ErreurAdmin(503, "Assistance indisponible : aucune clé configurée", "AI_DISABLED");
  const reponse = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${env.assistant.model}:generateContent?key=${cle}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: consigne }] },
        contents: [{ role: "user", parts: [{ text: contenu }] }],
        /*
         * 🐛 « RÉPONSE ILLISIBLE » (signalé le 24/10/2026) : gemini-2.5-flash
         * RÉFLÉCHIT avant de répondre, et sa réflexion se paie sur la même
         * limite. Mesuré : 1 840 jetons de réflexion sur 2 048 pour traduire la
         * bienvenue en deux langues — le JSON s'arrêtait au milieu
         * (`MAX_TOKENS`). Traduire ne demande pas de réflexion : on la coupe
         * (`thinkingBudget: 0`, aussi plus rapide), et la limite est relevée.
         */
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 8192,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  ).catch(() => null);
  if (!reponse?.ok) throw new ErreurAdmin(502, "L'assistance n'a pas répondu, réessayez", "AI_UNAVAILABLE");
  const json = (await reponse.json().catch(() => null)) as {
    candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  } | null;
  const candidat = json?.candidates?.[0];
  // Les fragments de réflexion éventuels ne font pas partie de la réponse.
  const texte = candidat?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? "").join("") ?? "";
  if (candidat?.finishReason === "MAX_TOKENS") {
    throw new ErreurAdmin(502, "Texte trop long pour l'assistance : traduisez-le en plusieurs blocs", "AI_TOO_LONG");
  }
  try {
    return JSON.parse(texte) as T;
  } catch {
    throw new ErreurAdmin(502, "Réponse de l'assistance illisible, réessayez", "AI_BAD_RESPONSE");
  }
}

function nature(kind: unknown) {
  const n = NATURES[String(kind)];
  if (!n) throw new ErreurAdmin(400, "Nature de contenu inconnue", "INVALID_KIND");
  return n;
}

export async function traduire(brut: unknown) {
  const c = (brut ?? {}) as { content?: unknown; kind?: unknown; sourceLocale?: unknown; targets?: unknown };
  const texte = String(c.content ?? "").trim();
  if (!texte || texte.length > 4000) throw new ErreurAdmin(400, "Texte requis (4 000 caractères au plus)", "VALIDATION");
  const source = String(c.sourceLocale ?? "fr");
  const cibles = (Array.isArray(c.targets) ? c.targets.map(String) : ["en"]).filter((l) => LANGUES[l] && l !== source);
  const r = await demander<{ translations?: Record<string, string>; notes?: string[] }>(
    `Tu traduis ${nature(c.kind)}. Garde le ton, la mise en forme (*gras*, _italique_, sauts de ligne), ` +
      `les noms propres et les liens. Réponds en JSON : {"translations": {"<code langue>": "<texte>"}, "notes": ["<remarque utile au relecteur>"]}.`,
    `Langue source : ${LANGUES[source] ?? source}. Traduire vers : ${cibles.map((l) => `${l} (${LANGUES[l]})`).join(", ")}.\n\n${texte}`,
  );
  const translations = Object.fromEntries(
    Object.entries(r.translations ?? {}).filter(([l, v]) => cibles.includes(l) && typeof v === "string" && v.trim()),
  );
  return {
    translations,
    missing: cibles.filter((l) => !translations[l]),
    notes: Array.isArray(r.notes) ? r.notes.map(String).slice(0, 10) : [],
    model: env.assistant.model,
  };
}

export async function relire(brut: unknown) {
  const c = (brut ?? {}) as { translations?: Record<string, unknown>; kind?: unknown };
  const textes = Object.entries(c.translations ?? {}).filter(([l, v]) => LANGUES[l] && typeof v === "string" && v.trim());
  if (textes.length === 0) throw new ErreurAdmin(400, "Rien à relire", "VALIDATION");
  const r = await demander<{ findings?: { locale?: string; severity?: string; message?: string }[] }>(
    `Tu relis ${nature(c.kind)} avant publication. Signale les fautes, les ambiguïtés, les incohérences entre ` +
      `langues, et tout ce qui pourrait choquer ou induire en erreur. Pas de reformulation de goût. ` +
      `Réponds en JSON : {"findings": [{"locale": "<code>", "severity": "bloquant|attention|suggestion", "message": "<en français>"}]}. ` +
      `Liste vide si tout est bon.`,
    textes.map(([l, v]) => `[${l}]\n${v}`).join("\n\n"),
  );
  const graves = ["bloquant", "attention", "suggestion"];
  return {
    findings: (r.findings ?? [])
      .filter((f) => f && typeof f.message === "string")
      .map((f) => ({
        locale: LANGUES[String(f.locale)] ? String(f.locale) : textes[0][0],
        severity: graves.includes(String(f.severity)) ? String(f.severity) : "suggestion",
        message: String(f.message).slice(0, 500),
      }))
      .slice(0, 20),
    model: env.assistant.model,
  };
}
