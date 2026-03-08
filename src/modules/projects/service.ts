import { prisma } from '../../db/client.js';

export async function getProjectsWithTaskCount(userId: number) {
	return prisma.project.findMany({
		where: { userId },
		include: {
			_count: {
				select: { tasks: { where: { isCompleted: false, isDeleted: false } } },
			},
		},
		orderBy: { name: 'asc' },
	});
}

export async function deleteProject(projectId: number, userId: number) {
	return prisma.project.deleteMany({
		where: { id: projectId, userId },
	});
}

export async function renameProject(projectId: number, userId: number, newName: string) {
	const existing = await prisma.project.findFirst({
		where: { id: projectId, userId },
	});

	if (!existing) return null;

	return prisma.project.update({
		where: { id: projectId },
		data: { name: newName },
	});
}
