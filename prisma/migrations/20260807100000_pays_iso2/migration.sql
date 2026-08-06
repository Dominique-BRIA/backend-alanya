-- Code ISO 3166-1 alpha-2 sur la table `pays`.
--
-- POURQUOI cette colonne plutot que des libelles traduits.
--
-- La table portait `libelle` (francais) et `libelleAnglais`. Deux langues sur
-- les neuf que parle l'application : un utilisateur russophone ou chinois
-- lisait donc les pays en francais. Ajouter sept colonnes de plus aurait
-- demande une colonne de plus a chaque langue future, et une traduction a
-- fournir pour 66 lignes a chaque fois.
--
-- Le code ISO regle le probleme une fois pour toutes : les clients traduisent
-- localement (`Intl.DisplayNames` sur le web, equivalent natif sur mobile),
-- dans TOUTES les langues, sans rien a maintenir. Une colonne au lieu de sept,
-- et gratuit pour toute langue ajoutee plus tard.
--
-- Nullable a dessein : un pays sans code s'affiche avec son `libelle`, comme
-- aujourd'hui. Aucune regression possible si une ligne manque a l'appel.
ALTER TABLE "pays" ADD COLUMN IF NOT EXISTS "iso2" CHAR(2);

-- Remplissage par le nom anglais, qui est la forme canonique du referentiel.
-- Ecrit en UPDATE cible plutot qu'en CASE geant : une ligne absente de la base
-- ne fait rien, et relancer le fichier est sans effet.
UPDATE "pays" SET "iso2" = 'AO' WHERE "libelleAnglais" = 'Angola' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'AT' WHERE "libelleAnglais" = 'Austria' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'BE' WHERE "libelleAnglais" = 'Belgium' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'BF' WHERE "libelleAnglais" = 'Burkina Faso' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'BI' WHERE "libelleAnglais" = 'Burundi' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'BJ' WHERE "libelleAnglais" = 'Benin' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'BW' WHERE "libelleAnglais" = 'Botswana' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'CA' WHERE "libelleAnglais" = 'Canada' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'CD' WHERE "libelleAnglais" = 'Democratic Republic of the Congo' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'CF' WHERE "libelleAnglais" = 'Central African Republic' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'CG' WHERE "libelleAnglais" = 'Congo' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'CH' WHERE "libelleAnglais" = 'Switzerland' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'CI' WHERE "libelleAnglais" = 'Ivory Coast' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'CI' WHERE "libelleAnglais" = 'Cote d''Ivoire' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'CI' WHERE "libelleAnglais" = 'Côte d''Ivoire' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'CM' WHERE "libelleAnglais" = 'Cameroon' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'CV' WHERE "libelleAnglais" = 'Cabo Verde' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'DE' WHERE "libelleAnglais" = 'Germany' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'DJ' WHERE "libelleAnglais" = 'Djibouti' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'DZ' WHERE "libelleAnglais" = 'Algeria' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'EG' WHERE "libelleAnglais" = 'Egypt' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'EH' WHERE "libelleAnglais" = 'Western Sahara' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'ER' WHERE "libelleAnglais" = 'Eritrea' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'ET' WHERE "libelleAnglais" = 'Ethiopia' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'FR' WHERE "libelleAnglais" = 'France' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'GA' WHERE "libelleAnglais" = 'Gabon' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'GH' WHERE "libelleAnglais" = 'Ghana' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'GM' WHERE "libelleAnglais" = 'Gambia' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'GN' WHERE "libelleAnglais" = 'Guinea' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'GQ' WHERE "libelleAnglais" = 'Equatorial Guinea' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'GW' WHERE "libelleAnglais" = 'Guinea-Bissau' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'KE' WHERE "libelleAnglais" = 'Kenya' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'KM' WHERE "libelleAnglais" = 'Comoros' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'LI' WHERE "libelleAnglais" = 'Liechtenstein' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'LR' WHERE "libelleAnglais" = 'Liberia' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'LS' WHERE "libelleAnglais" = 'Lesotho' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'LU' WHERE "libelleAnglais" = 'Luxembourg' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'LY' WHERE "libelleAnglais" = 'Libya' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'MA' WHERE "libelleAnglais" = 'Morocco' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'MC' WHERE "libelleAnglais" = 'Monaco' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'MG' WHERE "libelleAnglais" = 'Madagascar' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'ML' WHERE "libelleAnglais" = 'Mali' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'MR' WHERE "libelleAnglais" = 'Mauritania' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'MU' WHERE "libelleAnglais" = 'Mauritius' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'MW' WHERE "libelleAnglais" = 'Malawi' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'MZ' WHERE "libelleAnglais" = 'Mozambique' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'NA' WHERE "libelleAnglais" = 'Namibia' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'NE' WHERE "libelleAnglais" = 'Niger' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'NG' WHERE "libelleAnglais" = 'Nigeria' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'NL' WHERE "libelleAnglais" = 'Netherlands' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'RW' WHERE "libelleAnglais" = 'Rwanda' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'SC' WHERE "libelleAnglais" = 'Seychelles' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'SD' WHERE "libelleAnglais" = 'Sudan' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'SL' WHERE "libelleAnglais" = 'Sierra Leone' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'SN' WHERE "libelleAnglais" = 'Senegal' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'SO' WHERE "libelleAnglais" = 'Somalia' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'SS' WHERE "libelleAnglais" = 'South Sudan' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'ST' WHERE "libelleAnglais" = 'Sao Tome and Principe' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'SZ' WHERE "libelleAnglais" = 'Eswatini' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'TD' WHERE "libelleAnglais" = 'Chad' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'TG' WHERE "libelleAnglais" = 'Togo' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'TN' WHERE "libelleAnglais" = 'Tunisia' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'TZ' WHERE "libelleAnglais" = 'Tanzania' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'UG' WHERE "libelleAnglais" = 'Uganda' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'US' WHERE "libelleAnglais" = 'United States' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'ZA' WHERE "libelleAnglais" = 'South Africa' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'ZM' WHERE "libelleAnglais" = 'Zambia' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'ZW' WHERE "libelleAnglais" = 'Zimbabwe' AND "iso2" IS NULL;

-- Filet : les 25 pays d'origine n'ont pas tous un libelle anglais renseigne.
-- On rattrape par l'indicatif telephonique, unique pour ces pays-la.
UPDATE "pays" SET "iso2" = 'CM' WHERE prefix = '+237' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'CI' WHERE prefix = '+225' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'CD' WHERE prefix = '+243' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'CG' WHERE prefix = '+242' AND "iso2" IS NULL;
UPDATE "pays" SET "iso2" = 'GB' WHERE prefix = '+44'  AND "iso2" IS NULL;
