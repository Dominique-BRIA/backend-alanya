import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Mélange les deux pistes d'un enregistrement d'appel en un seul fichier.
 *
 * 🔴 POURQUOI DEUX PISTES AU DÉPART. Le greffon `flutter_webrtc` ne sait
 * enregistrer qu'un côté à la fois — vérifié dans son code Android, où
 * `startRecordingToFile` choisit `inputSamplesInterceptor` OU
 * `outputSamplesInterceptor`, jamais les deux. Le téléphone envoie donc le micro
 * et le distant séparément, et le mélange se fait ici.
 *
 * ffmpeg est **présent sur le VPS** — `/usr/bin/ffmpeg` 6.1.1, filtre `amix`
 * disponible, vérifié le 20/08/2026. ⚠️ Un premier contrôle avait conclu le
 * contraire : `which ffmpeg` n'avait rien rendu dans un shell SSH non
 * interactif, alors que le binaire était bien là. **Contrôler avec
 * `command -v`, ou mieux `ffmpeg -version`** — une commande muette ne prouve
 * pas une absence.
 *
 * ⚠️ **SON ABSENCE RESTE TRAITÉE, ET CE N'EST PAS DU ZÈLE** : un serveur neuf,
 * une image allégée ou une purge de paquets suffiraient. On rend alors `null`,
 * l'enregistrement reste en `statut = 0` avec ses deux pistes intactes, et le
 * mélange pourra être refait. Rien n'est perdu — c'est tout l'intérêt de
 * conserver les pistes brutes.
 */

/** ffmpeg est-il utilisable ? Sondé UNE fois, le binaire n'apparaît pas seul. */
let ffmpegDisponible: boolean | null = null;

export async function ffmpegPresent(): Promise<boolean> {
  if (ffmpegDisponible !== null) return ffmpegDisponible;
  ffmpegDisponible = await new Promise<boolean>((resolve) => {
    try {
      const p = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
      p.on("error", () => resolve(false));
      p.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
  return ffmpegDisponible;
}

/**
 * Rend les octets du fichier mélangé, ou `null` si le mélange n'a pas pu être
 * fait. Ne lève jamais : l'appelant doit pouvoir continuer sans.
 *
 * ⚠️ `amix` et non `amerge` : `amerge` produirait deux CANAUX distincts —
 * l'agent à gauche, le client à droite — ce qui est joli en théorie et
 * inaudible sur un téléphone tenu à l'oreille, où l'on n'entendrait qu'une
 * seule voix. `amix` additionne les deux en une piste mono, comme une vraie
 * conversation.
 *
 * ⚠️ `duration=longest` : les deux pistes n'ont pas exactement la même durée —
 * elles sont démarrées et arrêtées l'une après l'autre. Le défaut de `amix` est
 * `longest` mais on l'écrit, parce que `shortest` couperait la fin de la
 * conversation sans le moindre avertissement.
 *
 * ⚠️ `normalize=0` : sans lui, `amix` DIVISE le volume par le nombre d'entrées.
 * Un enregistrement à deux pistes sortirait deux fois trop faible, et personne
 * ne comprendrait pourquoi il faut monter le son à fond pour l'écouter.
 */
export async function melangerPistes(
  pisteAgent: Buffer,
  pisteClient: Buffer,
): Promise<Buffer | null> {
  if (!(await ffmpegPresent())) return null;

  let dossier: string | null = null;
  try {
    dossier = await mkdtemp(path.join(tmpdir(), "alanya-melange-"));
    const entreeA = path.join(dossier, "agent.aac");
    const entreeB = path.join(dossier, "client.aac");
    const sortie = path.join(dossier, "melange.m4a");
    await writeFile(entreeA, pisteAgent);
    await writeFile(entreeB, pisteClient);

    const code = await new Promise<number>((resolve) => {
      const p = spawn("ffmpeg", [
        "-hide_banner",
        "-loglevel", "error",
        "-i", entreeA,
        "-i", entreeB,
        "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[a]",
        "-map", "[a]",
        "-ac", "1",
        "-c:a", "aac",
        "-b:a", "64k",
        // Écrase la sortie sans demander : le dossier est temporaire et à nous.
        "-y", sortie,
      ]);
      p.on("error", () => resolve(-1));
      p.on("close", (c) => resolve(c ?? -1));
    });
    if (code !== 0) return null;
    return await readFile(sortie);
  } catch (e) {
    console.error("[melange] échec :", e instanceof Error ? e.message : e);
    return null;
  } finally {
    // Le dossier temporaire porte plusieurs minutes d'audio : le laisser
    // traîner remplirait le disque sans que personne ne le remarque.
    if (dossier) await rm(dossier, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Mélange un enregistrement déjà déposé, et range le résultat.
 *
 * ⚠️ **NE LÈVE JAMAIS.** Elle est lancée SANS être attendue depuis la route de
 * dépôt : le téléphone n'a aucune raison d'attendre plusieurs secondes de
 * `ffmpeg` alors que l'appel est déjà terminé. Une exception qui remonterait là
 * n'aurait personne pour l'attraper.
 *
 * ⚠️ Idempotente : elle ne traite que les lignes en `statut = 0`, et pose `1`
 * avant de commencer. Deux passages simultanés — un dépôt et un balayage — ne
 * mélangeront donc pas deux fois le même enregistrement.
 *
 * Un échec repose `statut = 3` en laissant les DEUX PISTES INTACTES : le
 * mélange reste refaisable, c'est tout l'intérêt de les conserver.
 */
export async function melangerEnregistrement(idRecording: string): Promise<void> {
  try {
    const { prisma } = await import("@/lib/prisma");
    const { readStored, saveBuffer } = await import("@/modules/media/storage");

    // `updateMany` avec le statut dans le `where` : c'est le verrou. Un second
    // appel ne trouvera plus la ligne en `0` et repartira sans rien faire.
    const pris = await prisma.callRecording.updateMany({
      where: { idRecording, statut: 0 },
      data: { statut: 1 },
    });
    if (pris.count === 0) return;

    const ligne = await prisma.callRecording.findUnique({
      where: { idRecording },
      select: {
        dureeMs: true,
        mediaAgent: { select: { url: true } },
        mediaClient: { select: { url: true } },
      },
    });
    if (!ligne) return;

    const [agent, client] = await Promise.all([
      readStored(ligne.mediaAgent.url),
      readStored(ligne.mediaClient.url),
    ]);
    const melange = await melangerPistes(agent, client);
    if (!melange) {
      await prisma.callRecording.update({
        where: { idRecording },
        data: { statut: 3 },
      });
      return;
    }

    const { relativeUrl } = await saveBuffer(melange, "appel.m4a", "audio/mp4");
    const media = await prisma.mediaFile.create({
      data: {
        // Le mélange appartient au MÊME compte que ses pistes : c'est ce qui
        // rend la route de lecture des médias cohérente sans cas particulier.
        ownerId: (await prisma.callRecording.findUniqueOrThrow({
          where: { idRecording },
          select: { agentId: true },
        })).agentId!,
        filename: "appel.m4a",
        mimeType: "audio/mp4",
        sizeBytes: melange.length,
        url: relativeUrl,
        durationMs: ligne.dureeMs,
      },
      select: { id: true },
    });

    await prisma.callRecording.update({
      where: { idRecording },
      data: { mediaMixId: media.id, statut: 2 },
    });
    console.log(`[melange] enregistrement ${idRecording} melange (${melange.length} octets)`);
  } catch (e) {
    console.error("[melange] echec sur", idRecording, e instanceof Error ? e.message : e);
    try {
      const { prisma } = await import("@/lib/prisma");
      await prisma.callRecording.update({
        where: { idRecording },
        data: { statut: 3 },
      });
    } catch {
      // Même la remise en échec a échoué : la ligne reste en `1`. Un balayage
      // ultérieur devra la reprendre — c'est le prix d'un processus qui meurt
      // au mauvais moment, et il n'y a rien à faire de mieux ici.
    }
  }
}
