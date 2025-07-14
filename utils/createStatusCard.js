// utils/createStatusCard.js
import { createCanvas, loadImage, registerFont } from 'canvas';
import path from 'path';
import { fileURLToPath } from 'url';

// Fix font paths
const __dirname = path.dirname(fileURLToPath(import.meta.url));
registerFont(path.join(__dirname, '../fonts/arial.ttf'), { family: 'Arial' });

export async function createStatusCard(userData, avatarURL) {
    try {
        // Create canvas
        const canvas = createCanvas(800, 300);
        const ctx = canvas.getContext('2d');

        // Background
        ctx.fillStyle = '#2C2F33';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Avatar
        try {
            const avatar = await loadImage(avatarURL);
            ctx.save();
            ctx.beginPath();
            ctx.arc(150, 150, 100, 0, Math.PI * 2, true);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(avatar, 50, 50, 200, 200);
            ctx.restore();
        } catch (error) {
            console.error('Error loading avatar:', error);
        }

        // User info
        ctx.fillStyle = '#FFFFFF';
        ctx.font = '30px Arial';
        ctx.fillText(userData.username, 300, 80);

        // Level and XP
        ctx.font = '24px Arial';
        ctx.fillText(`Level: ${userData.lvl}`, 300, 120);
        ctx.fillText(`XP: ${userData.xp}`, 300, 150);

        // Streak
        ctx.fillText(`Streak: ${userData.streak} days`, 300, 180);

        // Booster status
        if (userData.isBooster) {
            ctx.fillStyle = '#FF73FA';
            ctx.font = 'bold 20px Arial';
            ctx.fillText(`✨ Server Booster (${userData.multiplier}x XP)`, 300, 220);
        }

        return canvas.toBuffer('image/png');
    } catch (error) {
        console.error('Error creating status card:', error);
        throw error;
    }
}
