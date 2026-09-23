/** Imprime le statut du dernier appel de la base de dev. Sert au banc d'essai. */
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()
const dernier = await prisma.call.findFirst({
  orderBy: { startedAt: "desc" },
  select: { id: true, status: true, answeredAt: true },
})
console.log(dernier ? `${dernier.status} ${dernier.answeredAt ? "repondu" : "nonrepondu"} ${dernier.id}` : "AUCUN")
await prisma.$disconnect()
