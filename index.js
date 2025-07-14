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
  const avatarSize = 128;
  const avatarX = 30;
  const avatarY = (canvas.height - avatarSize) / 2;
  const avatar = await loadImage(avatarURL);
  ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);

  // Avatar Border
  ctx.strokeStyle = '#7289da';
  ctx.lineWidth = 6;
  ctx.strokeRect(avatarX, avatarY, avatarSize, avatarSize);

  // Text Properties
  const startX = avatarX + avatarSize + 30;
  let currentY = 50;
  const lineSpacing = 35;

  ctx.fillStyle = '#ffffff';
  ctx.font = '28px OpenSans';
  ctx.fillText(`User: ${user.username}`, startX, currentY);
  currentY += lineSpacing;
  ctx.fillText(`XP: ${user.xp}`, startX, currentY);
  currentY += lineSpacing;
  ctx.fillText(`Level: ${user.lvl}`, startX, currentY);
  currentY += lineSpacing;
  ctx.fillText(`Streak: ${user.streak} days`, startX, currentY);

  // Booster Tag
  if (user.isBooster) {
    currentY += lineSpacing;
    ctx.fillStyle = '#ff73fa';
    ctx.font = 'bold 20px "Segoe UI"';
    ctx.fillText(`✨ Server Booster (${user.multiplier}x XP)`, startX, currentY);
  }

  // Progress Bar
  const barMarginTop = 30;
  const barX = startX;
  const barY = currentY + barMarginTop;
  const barWidth = 560;
  const barHeight = 20;

  const xpForNextLevel = Math.pow(user.lvl, 2) * 10;
  const percent = Math.min(user.xp / xpForNextLevel, 1);

  ctx.fillStyle = '#3e3f40';
  ctx.fillRect(barX, barY, barWidth, barHeight);

  ctx.fillStyle = '#43b581';
  ctx.fillRect(barX, barY, barWidth * percent, barHeight);

  return canvas.toBuffer('image/png');
}
