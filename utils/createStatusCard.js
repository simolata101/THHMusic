// utils/createStatusCard.js
import { createCanvas, loadImage } from 'canvas';
import path from 'path';

export async function createStatusCard(user, avatarUrl) {
    const canvas = createCanvas(800, 250);
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#2C2F33';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Avatar
    const avatar = await loadImage(avatarUrl.replace('.webp', '.png'));
    ctx.drawImage(avatar, 40, 40, 170, 170);
    ctx.strokeStyle = '#7289da';
    ctx.lineWidth = 8;
    ctx.strokeRect(40, 40, 170, 170);

    // Username
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px Sans-serif';
    ctx.fillText(user.username, 230, 70);

    // Level & XP Bar
    ctx.font = '24px Sans-serif';
    ctx.fillStyle = '#bbbbbb';
    ctx.fillText(`Level: ${user.lvl}`, 230, 110);
    ctx.fillText(`XP: ${user.xp}`, 230, 150);
    ctx.fillText(`🔥 Streak: ${user.streak} days`, 230, 190);

    // XP bar
    const barWidth = 400;
    const xpForNextLevel = Math.pow(user.lvl, 2) * 10;
    const progress = Math.min(user.xp / xpForNextLevel, 1);
    ctx.fillStyle = '#444';
    ctx.fillRect(230, 210, barWidth, 20);
    ctx.fillStyle = '#43b581';
    ctx.fillRect(230, 210, barWidth * progress, 20);

    return canvas.toBuffer('image/png');
}
