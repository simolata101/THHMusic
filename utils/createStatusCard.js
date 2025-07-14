import { createCanvas, loadImage, registerFont } from 'canvas';
import path from 'path';
import fs from 'fs';

const fontPath = path.join(process.cwd(), 'assets/fonts/OpenSans-Regular.ttf');
if (fs.existsSync(fontPath)) {
  registerFont(fontPath, { family: 'OpenSans' });
}

export async function createStatusCard(user, avatarURL) {
  const canvas = createCanvas(800, 250);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#2c2f33';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Avatar
  const avatar = await loadImage(avatarURL);
  ctx.drawImage(avatar, 30, 30, 128, 128);

  // Border
  ctx.strokeStyle = '#7289da';
  ctx.lineWidth = 6;
  ctx.strokeRect(30, 30, 128, 128);

  // Text
  ctx.fillStyle = '#ffffff';
  ctx.font = '28px OpenSans';
  ctx.fillText(`User: ${user.username}`, 180, 50);
  ctx.fillText(`XP: ${user.xp}`, 180, 90);
  ctx.fillText(`Level: ${user.lvl}`, 180, 130);
  ctx.fillText(`Streak: ${user.streak} days`, 180, 170);

  if (user.isBooster) {
      // Position this wherever you want on the card
      ctx.fillStyle = '#ff73fa';
      ctx.font = 'bold 20px "Segoe UI"';
      ctx.fillText(`✨ Server Booster (${user.multiplier}x XP)`, 180, 210);
  }

  // Progress Bar
  const barX = 180, barY = 230, barWidth = 560, barHeight = 20;
  const xpForNextLevel = (Math.pow(user.lvl, 2)) * 10;
  const percent = Math.min(user.xp / xpForNextLevel, 1);

  ctx.fillStyle = '#3e3f40';
  ctx.fillRect(barX, barY, barWidth, barHeight);

  ctx.fillStyle = '#43b581';
  ctx.fillRect(barX, barY, barWidth * percent, barHeight);

  return canvas.toBuffer('image/png');
}
