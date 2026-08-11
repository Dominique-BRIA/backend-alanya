import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
export const PATCH = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const id = Number((await ctx.params).id); const { automatic } = await req.json();
  if (!Number.isInteger(id) || typeof automatic !== "boolean") return fail("Données invalides",400,"BAD_REQUEST");
  const m = await prisma.meeting.findUnique({ where:{idMeeting:id}, select:{idOrganiser:true,isEnd:true} });
  if (!m) return fail("Réunion introuvable",404,"NOT_FOUND");
  if (m.idOrganiser !== userId) return fail("Accès refusé",403,"FORBIDDEN");
  if (m.isEnd === 1) return fail("Cette réunion est terminée",409,"MEETING_ENDED");
  await prisma.meeting.update({where:{idMeeting:id},data:{invitationAuto:automatic?1:0}});
  return ok({automatic});
});
