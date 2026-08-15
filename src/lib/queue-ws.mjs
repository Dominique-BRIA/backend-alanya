// Helpers de gestion de la file d'attente pour le serveur WebSocket (ws-server.mjs)

export async function ajouterClientFileWS(prisma, { idCompany, centerAlanyaID, idCustomer, idService = null, idAgent = null, priorite = 0 }) {
  try {
    const maxFile = await prisma.queueFile.findFirst({
      where: { center_alanyaID: centerAlanyaID },
      orderBy: { rang: "desc" },
      select: { rang: true },
    });
    const nouveauRang = (maxFile?.rang ?? 0) + 1;
    return await prisma.queueFile.upsert({
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
  } catch (e) {
    console.error("[queue-ws] erreur ajouterClientFile:", e?.message ?? e);
    return null;
  }
}

export async function depilerClientSuivantWS(prisma, centerAlanyaID, idAgent = null) {
  try {
    const premierClient = await prisma.queueFile.findFirst({
      where: { center_alanyaID: centerAlanyaID },
      orderBy: [
        { priorite: "desc" },
        { rang: "asc" },
        { createdAt: "asc" },
      ],
    });
    if (!premierClient) return null;

    const maintenant = new Date();
    const attenteSec = Math.max(0, Math.floor((maintenant.getTime() - premierClient.createdAt.getTime()) / 1000));

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

    await prisma.queueFile.delete({
      where: { idFile: premierClient.idFile },
    });

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
  } catch (e) {
    console.error("[queue-ws] erreur depilerClientSuivant:", e?.message ?? e);
    return null;
  }
}

export async function abandonnerFileWS(prisma, centerAlanyaID, idCustomer) {
  try {
    const clientEnAttente = await prisma.queueFile.findUnique({
      where: {
        center_alanyaID_idCustomer: {
          center_alanyaID: centerAlanyaID,
          idCustomer: idCustomer,
        },
      },
    });
    if (!clientEnAttente) return null;

    const maintenant = new Date();
    const attenteSec = Math.max(0, Math.floor((maintenant.getTime() - clientEnAttente.createdAt.getTime()) / 1000));

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

    await prisma.queueFile.delete({
      where: { idFile: clientEnAttente.idFile },
    });

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
  } catch (e) {
    console.error("[queue-ws] erreur abandonnerFile:", e?.message ?? e);
    return null;
  }
}
