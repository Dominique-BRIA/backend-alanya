import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ok, fail } from '@/lib/http';
import { withAuth } from '@/lib/auth-context';

// GET /api/developer/workspaces — Liste des Workspaces/Projets du développeur
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  try {
    let developer = await prisma.developerAccount.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!developer) {
      developer = await prisma.developerAccount.create({
        data: { userId, balanceCredits: BigInt(1000) },
        select: { id: true },
      });
    }

    let workspaces = await prisma.developerWorkspace.findMany({
      where: { developerId: developer.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
      },
    });

    // Créer un espace par défaut s'il n'en possède pas encore
    if (workspaces.length === 0) {
      const defaultWs = await prisma.developerWorkspace.create({
        data: {
          developerId: developer.id,
          name: 'Mon Projet Principal',
          description: 'Espace de travail par défaut pour vos intégrations Alanya',
        },
        select: {
          id: true,
          name: true,
          description: true,
          createdAt: true,
        },
      });
      workspaces = [defaultWs];
    }

    return ok({ workspaces });
  } catch (error: any) {
    console.error('[API Developer Workspaces] Erreur:', error);
    return fail('Erreur lors de la récupération des workspaces', 500);
  }
});

// POST /api/developer/workspaces — Création d'un nouveau Workspace/Projet
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  try {
    let developer = await prisma.developerAccount.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!developer) {
      developer = await prisma.developerAccount.create({
        data: { userId, balanceCredits: BigInt(1000) },
        select: { id: true },
      });
    }

    const body = await req.json().catch(() => ({}));
    const name = body.name?.toString().trim();
    const description = body.description?.toString().trim() || null;

    if (!name) {
      return fail('Le nom du projet/workspace est requis.', 400);
    }

    const workspace = await prisma.developerWorkspace.create({
      data: {
        developerId: developer.id,
        name,
        description,
      },
      select: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
      },
    });

    return ok({ workspace }, 201);
  } catch (error: any) {
    console.error('[API Developer Workspaces] Erreur de création:', error);
    return fail('Erreur de création du workspace', 500);
  }
});
