// index.js (Discord Gamble Bot with prefix-based commands)

import { Client, GatewayIntentBits, PermissionsBitField } from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const PREFIX = 'thh!';
const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

bot.on('ready', () => console.log(`Bot ready as ${bot.user.tag}`));

bot.on('messageCreate', async msg => {
  if (msg.author.bot) return;

  const uid = msg.author.id;
  const now = new Date().toISOString().split('T')[0];
  const { data: user } = await supa.from('users').select().eq('user_id', uid).single();
  if (!user) await supa.from('users').insert({ user_id: uid, xp: 0, coins: 0, lvl: 1, streak: 1, last_active: now });

  if (msg.content.startsWith(PREFIX)) {
    const args = msg.content.slice(PREFIX.length).trim().split(/ +/);
    const cmd = args.shift().toLowerCase();
    const { data } = await supa.from('users').select().eq('user_id', uid).single();

    if (data.last_active !== now) {
      const yest = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      const newStreak = data.last_active === yest ? data.streak + 1 : 1;
      await supa.from('users').update({ streak: newStreak, last_active: now }).eq('user_id', uid);
      data.streak = newStreak;
    }

    if (cmd === 'help') {
      msg.reply(`📘 **Bot Help**\n\n${PREFIX}balance – Show your XP, coins, level, streak\n${PREFIX}gamble [game] [bet] – Play highlow, coinflip, dice, slots, bomb\n${PREFIX}buycurrency [amount] – Convert XP into coins (10 XP = 1 coin)\n${PREFIX}shop – View buyable roles\n${PREFIX}buyrole [@role] – Buy a role using coins`);
    }

    if (cmd === 'balance') {
      msg.reply(`XP: ${data.xp}, Level: ${data.lvl}, Coins: ${data.coins}, Streak: ${data.streak} days`);
    }

    if (cmd === 'buycurrency') {
      const amount = parseInt(args[0]);
      const xpCost = amount * 10;
      if (data.xp < xpCost) return msg.reply(`Not enough XP. You need ${xpCost} XP.`);
      await supa.from('users').update({ xp: data.xp - xpCost, coins: data.coins + amount }).eq('user_id', uid);
      return msg.reply(`You converted ${xpCost} XP into ${amount} coins.`);
    }

    if (cmd === 'shop') {
      const { data: roles } = await supa.from('shop').select();
      if (!roles.length) return msg.reply('No roles in the shop.');
      const list = roles.map(r => `${r.role_name} – ${r.cost} coins`).join('\n');
      return msg.reply(`🛒 Shop:\n${list}`);
    }

    if (cmd === 'buyrole') {
      const role = msg.mentions.roles.first();
      if (!role) return msg.reply('Please mention a valid role.');
      const { data: shop } = await supa.from('shop').select().eq('role_id', role.id).single();
      if (!shop) return msg.reply('That role is not in the shop.');
      if (data.coins < shop.cost) return msg.reply(`You need ${shop.cost} coins.`);
      await supa.from('users').update({ coins: data.coins - shop.cost }).eq('user_id', uid);
      await msg.member.roles.add(role);
      return msg.reply(`You bought the role ${role.name} for ${shop.cost} coins.`);
    }

    if (cmd === 'gamble') {
      const game = args[0];
      const bet = parseInt(args[1]);
      if (!['highlow', 'coinflip', 'dice', 'slots', 'bomb'].includes(game)) return msg.reply('Game not found.');
      if (bet > data.coins || bet <= 0) return msg.reply('Invalid or insufficient bet.');

      let delta = 0;
      let result = '';
      const streakMult = 1 + data.streak * 0.01;

      if (game === 'highlow') {
        const u = Math.ceil(Math.random() * 13), b = Math.ceil(Math.random() * 13);
        delta = u > b ? Math.floor(bet * streakMult) : -bet;
        result = `HighLow: You ${u > b ? 'win' : 'lose'}! Your ${u} vs Bot ${b}`;
      }
      if (game === 'coinflip') {
        const flip = Math.random() < 0.5 ? 'heads' : 'tails';
        const guess = Math.random() < 0.5 ? 'heads' : 'tails';
        delta = flip === guess ? Math.floor(bet * streakMult) : -bet;
        result = `Coinflip: You ${flip === guess ? 'win' : 'lose'} (${guess} vs ${flip})`;
      }
      if (game === 'dice') {
        const u = Math.ceil(Math.random() * 100), b = Math.ceil(Math.random() * 100);
        delta = u > b ? Math.floor(bet * streakMult) : -bet;
        result = `Dice: You ${u > b ? 'win' : 'lose'}! You ${u}, Bot ${b}`;
      }
      if (game === 'slots') {
        const icons = ['🍒', '🍋', '🔔', '⭐'];
        const spin = Array.from({ length: 3 }, () => icons[Math.floor(Math.random() * icons.length)]);
        const win = spin.every(s => s === spin[0]);
        delta = win ? Math.floor(bet * 3 * streakMult) : -bet;
        result = `Slots: ${spin.join(' ')} ${win ? 'Jackpot!' : 'You lose.'}`;
      }
      if (game === 'bomb') {
        let mult = 1, safe = true;
        for (let i = 0; i < 5; i++) {
          if (Math.random() < 0.15) { safe = false; break; }
          mult += 0.5;
        }
        delta = safe ? Math.floor(bet * mult * streakMult) : -bet;
        result = safe ? `Bomb: You won ${delta} coins! Multiplier x${mult}` : 'Bomb: 💣 You hit a bomb!';
      }

      await supa.from('users').update({ coins: data.coins + delta, xp: data.xp + 5 }).eq('user_id', uid);
      return msg.reply(`${result}\nYou ${delta >= 0 ? 'gained' : 'lost'} ${Math.abs(delta)} coins.`);
    }
  } else {
    const { data } = await supa.from('users').select().eq('user_id', uid).single();
    const xpGain = 2 * (1 + data.streak * 0.01);
    const newXp = data.xp + Math.floor(xpGain);
    const newLvl = Math.floor(Math.sqrt(newXp / 10)) + 1;
    await supa.from('users').update({ xp: newXp, lvl: newLvl }).eq('user_id', uid);
  }
});

bot.login(process.env.DISCORD_TOKEN);
