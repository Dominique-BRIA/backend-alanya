import Image from "next/image";
import styles from "./page-lien.module.css";

/**
 * LA PAGE DE SECOURS D'UN LIEN ALANYA (QR code, lien partagé).
 *
 * On ne la voit que lorsque le téléphone n'a PAS ouvert l'application :
 *   · l'application n'est pas installée ;
 *   · le lien est ouvert sur un ordinateur ;
 *   · Android n'a pas encore vérifié le domaine (`/.well-known/assetlinks.json`).
 * Quand tout est en place, l'application intercepte le lien et cette page
 * n'est jamais chargée.
 *
 * Deux sorties, décidées par le user le 29/09/2026 :
 *   · « Ouvrir dans l'application » — sur Android seulement, par un lien
 *     `intent://` qui force l'ouverture de l'application si elle est là, et
 *     retombe sur le web sinon (`browser_fallback_url`) ;
 *   · « Continuer sur le web » — le client web `/webapp/`.
 * Pas de lien de téléchargement de l'APK pour le moment (décision du user).
 *
 * Dossier `_liens` : le soulignement le rend privé, Next ne le sert pas comme
 * une route. Il est partagé par `/u/<ID>` et, plus tard, `/i/<jeton>`.
 */

const PAQUET_ANDROID = "com.alanya237.work";
const WEB = "/webapp/";

/** Le lien `intent://` qui ouvre le même chemin dans l'application Android. */
function lienIntent(chemin: string, origine: string): string {
  const repli = encodeURIComponent(`${origine}${WEB}`);
  return (
    `intent://alanyavox.com${chemin}#Intent;scheme=https;` +
    `package=${PAQUET_ANDROID};S.browser_fallback_url=${repli};end`
  );
}

export function PageLien(props: {
  titre: string;
  sousTitre?: string;
  chemin: string;
  origine: string;
  android: boolean;
}) {
  return (
    <main className={styles.page}>
      <div className={styles.carte}>
        <Image
          src="/logo-alanya.png"
          alt="Alanya Work"
          width={88}
          height={88}
          priority
        />
        <p className={styles.marque}>Alanya Work</p>
        <h1 className={styles.titre}>{props.titre}</h1>
        {props.sousTitre && <p className={styles.sousTitre}>{props.sousTitre}</p>}

        <div className={styles.actions}>
          {props.android && (
            <a
              className={styles.principal}
              href={lienIntent(props.chemin, props.origine)}
            >
              Ouvrir dans l&apos;application
            </a>
          )}
          <a
            className={props.android ? styles.secondaire : styles.principal}
            href={WEB}
          >
            Continuer sur le web
          </a>
        </div>

        <p className={styles.note}>
          Si Alanya Work est installé sur votre téléphone, ce lien s&apos;ouvre
          directement dans l&apos;application.
        </p>
      </div>
    </main>
  );
}
