import { Composer } from 'grammy';
import type { BotContext } from '../../types/index.js';
import { ensureUser } from '../tasks/service.js';
import { getProjectsWithTaskCount } from './service.js';

export const projectsModule = new Composer<BotContext>();

projectsModule.command('projects', async (ctx) => {
	const telegramId = BigInt(ctx.from?.id ?? 0);
	const chatId = BigInt(ctx.chat.id);
	const user = await ensureUser(telegramId, chatId);

	const projects = await getProjectsWithTaskCount(user.id);

	if (projects.length === 0) {
		await ctx.reply(
			'📁 У вас пока нет проектов. Отправьте задачу, и проект создастся автоматически.',
		);
		return;
	}

	const lines = ['📁 *Ваши проекты*\n'];
	for (const project of projects) {
		const taskCount = project._count.tasks;
		lines.push(`• *${project.name}* — ${taskCount} задач`);
	}

	await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
});
