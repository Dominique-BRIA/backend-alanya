import { prisma } from "@/lib/prisma";

export interface JoinQueueParams {
  idCompany: number;
  centerAlanyaID: string;
  idCustomer: string;
  idService?: number | null;
  idAgent?: string | null;
  priorite?: number;
}

/**
 * Enregistre l'entrée d'un client dans la file d'attente active d'un centre.
 * Attribue automatiquement le rang suivant (FIFO).
 */
export async function ajouterClientFile(params: JoinQueueParams) {
  const { idCompany, centerAlanyaID, idCustomer, idService, idAgent, priorite = 0 } = params;

  // Calcul du rang suivant pour ce centre
  const maxFile = await prisma.queueFile.findFirst({
    where: { center_alanyaID: centerAlanyaID },
    orderBy: { rang: "desc" },
    select: { rang: true },
  });

  const nouveauRang = (maxFile?.rang ?? 0) + 1;

  // Insertion ou mise à jour si déjà présent
  const me = await prisma.queueFile.upsert({
    where: {
      center_alanyaID_idCustomer: {
        center_alanyaID: centerAlanyaID,
        idCustomer: idCustomer,
      },
    },
    create: {
      idCompany,
      center_alanyaID: centerAlanyaID,
      idCustomer,
      idService: idService ?? null,
      idAgent: idAgent ?? null,
      rang: nouveauRang,
      priorite,
    },
    update: {
      rang: nouveauRang,
      priorite,
      createdAt: new Date(),
    },
  });

  return {
    idFile: me.idFile,
    rang: me.rang,
  };
}

/**
 * Dépile le premier client en attente (FIFO) pour un centre dès qu'un agent se libère.
 * Transfère le client vers `file_historique` avec le statut MIS_EN_RELATION et réordonne les rangs des suivants.
 */
export async function depilerClientSuivant(centerAlanyaID: string, idAgent?: string | null) {
  // Récupération du client avec le plus petit rang
  const premierClient = await prisma.queueFile.findFirst({
    where: { center_alanyaID: centerAlanyaID },
    orderBy: [
      { priorite: "desc" },
      { rang: "asc" },
      { createdAt: "asc" },
    ],
  });

  if (!premierClient) {
    return null; // Aucun client en attente
  }

  const maintenant = new Date();
  const attenteSec = Math.max(0, Math.floor((maintenant.getTime() - premierClient.createdAt.getTime()) / 1000));

  // 1. Création de la ligne d'historique
  const hist = await prisma.queueFileHistorique.create({
    data: {
      idCompany: premierClient.idCompany,
      center_alanyaID: premierClient.center_alanyaID,
      idService: premierClient.idService,
      idAgent: idAgent ?? premierClient.idAgent,
      idCustomer: premierClient.idCustomer,
      statut: "MIS_EN_RELATION",
      joinedAt: premierClient.createdAt,
      leftAt: maintenant,
      attenteDureeSec: attenteSec,
      appelDureeSec: 0,
    },
  });

  // 2. Suppression de la file active
  await prisma.queueFile.delete({
    where: { idFile: premierClient.idFile },
  });

  // 3. Décrémentation des rangs des clients restants dans ce centre
  await prisma.queueFile.updateMany({
    where: {
      center_alanyaID: centerAlanyaID,
      rang: { gt: premierClient.rang },
    },
    data: {
      rang: { decrement: 1 },
    },
  });

  return {
    idHist: hist.idHist.toString(),
    idCustomer: premierClient.idCustomer,
    idService: premierClient.idService,
    idAgent: hist.idAgent,
    attenteDureeSec: attenteSec,
  };
}

/**
 * Enregistre l'abandon d'un client qui raccroche pendant l'attente.
 */
export async function abandonnerFile(centerAlanyaID: string, idCustomer: string) {
  const clientEnAttente = await prisma.queueFile.findUnique({
    where: {
      center_alanyaID_idCustomer: {
        center_alanyaID: centerAlanyaID,
        idCustomer: idCustomer,
      },
    },
  });

  if (!clientEnAttente) {
    return null;
  }

  const maintenant = new Date();
  const attenteSec = Math.max(0, Math.floor((maintenant.getTime() - clientEnAttente.createdAt.getTime()) / 1000));

  // 1. Création de la ligne d'historique avec statut ABANDON
  const hist = await prisma.queueFileHistorique.create({
    data: {
      idCompany: clientEnAttente.idCompany,
      center_alanyaID: clientEnAttente.center_alanyaID,
      idService: clientEnAttente.idService,
      idAgent: clientEnAttente.idAgent,
      idCustomer: clientEnAttente.idCustomer,
      statut: "ABANDON",
      joinedAt: clientEnAttente.createdAt,
      leftAt: maintenant,
      attenteDureeSec: attenteSec,
      appelDureeSec: 0,
    },
  });

  // 2. Suppression de la file active
  await prisma.queueFile.delete({
    where: { idFile: clientEnAttente.idFile },
  });

  // 3. Réindexation des rangs
  await prisma.queueFile.updateMany({
    where: {
      center_alanyaID: centerAlanyaID,
      rang: { gt: clientEnAttente.rang },
    },
    data: {
      rang: { decrement: 1 },
    },
  });

  return {
    idHist: hist.idHist.toString(),
    attenteDureeSec: attenteSec,
  };
}
