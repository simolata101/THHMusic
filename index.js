// index.js

import { Client, GatewayIntentBits, SlashCommandBuilder, PermissionsBitField } from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

// Register slash commands (run once)
bot.on('ready', async () => {
  const cmds = [
    new SlashCommandBuilder().setName('balance').setDescription('Show your stats'),
    new SlashCommandBuilder().setName('gamble')
      .addStringOption(opt => opt.setName('game').setDescription('Game name').setRequired(true)
        .addChoices(
          { name: 'highlow', value: 'highlow' },
          { name: 'coinflip', value: 'coinflip' },
          { name: 'dice', value: 'dice' },
          { name: 'slots', value: 'slots' },
          { name: 'bomb', value: 'bomb' }
        ))
      .addIntegerOption(opt => opt.setName('bet').setDescription('Bet amount').setRequired(true))
      .setDescription('Play a gambling game'),
    new SlashCommandBuilder().setName('buycurrency')
      .addIntegerOption(opt => opt.setName('amount').setDescription('Amount of coins to buy with XP').setRequired(true))
      .setDescription('Convert XP into coins'),
    new SlashCommandBuilder().setName('buyrole')
      .addRoleOption(opt => opt.setName('role').setDescription('Role to purchase').setRequired(true))
      .setDescription('Buy a Discord role with coins'),
    new SlashCommandBuilder().setName('addshoprole')
      .addRoleOption(opt => opt.setName('role').setDescription('Role to add to shop').setRequired(true))
      .addIntegerOption(opt => opt.setName('cost').setDescription('Cost in coins').setRequired(true))
      .setDescription('Add a role to the shop (admin only)'),
    new SlashCommandBuilder().setName('shop')
      .setDescription('View the shop roles available for purchase'),
    new SlashCommandBuilder().setName('help')
      .setDescription('Show command help')
  ].map(c => c.toJSON());
  await bot.application.commands.set(cmds);
  console.log('Bot ready');
});

bot.on('interactionCreate', async inter => {
  if (!inter.isChatInputCommand()) return;
  const uid = inter.user.id;

  const now = new Date().toISOString().split('T')[0];

  let { data, error } = await supa.from('users').select().eq('user_id', uid).single();

  if (!data) {
    const insertResult = await supa.from('users').insert({
      user_id: uid,
      coins: 0,
      xp: 0,
      lvl: 1,
      streak: 1,
      last_active: now
    }).select().single();
    data = insertResult.data;
  } else if (data.last_active !== now) {
    const yesterday = new Date(Date.now() - 86400e3).toISOString().split('T')[0];
    const newStreak = data.last_active === yesterday ? data.streak + 1 : 1;
    await supa.from('users').update({ streak: newStreak, last_active: now }).eq('user_id', uid);
    data.streak = newStreak;
  }

  if (inter.commandName === 'help') {
    return inter.reply(`📘 **Bot Help**

/balance - Show your XP, coins, level, streak
/gamble [game] [bet] - Play highlow, coinflip, dice, slots, or bomb
/buycurrency [amount] - Convert XP into coins (10 XP = 1 coin)
/shop - View buyable roles
/buyrole [role] - Purchase a role using coins
/addshoprole [role] [cost] - (Admin) Add role to shop`);
  }

  if (inter.commandName === 'balance') {
    return inter.reply(`XP: ${data.xp}, Level: ${data.lvl}, Coins: ${data.coins}, Streak: ${data.streak} days`);
  }

  if (inter.commandName === 'buycurrency') {
    const amount = inter.options.getInteger('amount');
    const xpCost = amount * 10;
    if (data.xp < xpCost) return inter.reply(`Not enough XP. You need ${xpCost} XP to buy ${amount} coins.`);
    await supa.from('users').update({ xp: data.xp - xpCost, coins: data.coins + amount }).eq('user_id', uid);
    return inter.reply(`You converted ${xpCost} XP into ${amount} coins.`);
  }

  if (inter.commandName === 'buyrole') {
    const role = inter.options.getRole('role');
    const { data: shop } = await supa.from('shop').select().eq('role_id', role.id).single();
    if (!shop) return inter.reply(`That role is not in the shop.`);
    if (data.coins < shop.cost) return inter.reply(`Not enough coins. You need ${shop.cost} coins.`);
    await supa.from('users').update({ coins: data.coins - shop.cost }).eq('user_id', uid);
    await inter.member.roles.add(role);
    return inter.reply(`You bought the role ${role.name} for ${shop.cost} coins.`);
  }

  if (inter.commandName === 'addshoprole') {
    if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('Only admins can use this.');
    const role = inter.options.getRole('role');
    const cost = inter.options.getInteger('cost');
    await supa.from('shop').upsert({ role_id: role.id, role_name: role.name, cost });
    return inter.reply(`Added ${role.name} to shop for ${cost} coins.`);
  }

  if (inter.commandName === 'shop') {
    const { data: roles } = await supa.from('shop').select();
    if (!roles.length) return inter.reply('No roles are available in the shop.');
    const list = roles.map(r => `${r.role_name} – ${r.cost} coins`).join('\n');
    return inter.reply(`🛒 Available Roles:\n${list}`);
  }

  if (inter.commandName === 'gamble') {
    const game = inter.options.getString('game');
    const bet = inter.options.getInteger('bet');
    if (bet > data.coins || bet <= 0) return inter.reply('Invalid or insufficient bet.');

    let delta = 0;
    let result = '';
    const streakMult = 1 + data.streak * 0.01;

    if (game === 'highlow') {
      const userCard = Math.ceil(Math.random() * 13);
      const botCard = Math.ceil(Math.random() * 13);
      if (userCard > botCard) {
        delta = Math.floor(bet * streakMult);
        result = `High-Low: You win! Your card ${userCard} > Bot card ${botCard}`;
      } else {
        delta = -bet;
        result = `High-Low: You lose. Your card ${userCard} <= Bot card ${botCard}`;
      }
    } else if (game === 'coinflip') {
      const flip = Math.random() < 0.5 ? 'heads' : 'tails';
      const userFlip = Math.random() < 0.5 ? 'heads' : 'tails';
      if (flip === userFlip) {
        delta = Math.floor(bet * streakMult);
        result = `Coinflip: You guessed ${userFlip} and won!`; 
      } else {
        delta = -bet;
        result = `Coinflip: You guessed ${userFlip}, but it was ${flip}. You lose.`;
      }
    } else if (game === 'dice') {
      const userRoll = Math.ceil(Math.random() * 100);
      const botRoll = Math.ceil(Math.random() * 100);
      if (userRoll > botRoll) {
        delta = Math.floor(bet * streakMult);
        result = `Dice: You rolled ${userRoll}, bot rolled ${botRoll}. You win!`;
      } else {
        delta = -bet;
        result = `Dice: You rolled ${userRoll}, bot rolled ${botRoll}. You lose.`;
      }
    } else if (game === 'slots') {
      const icons = ['🍒', '🍋', '🔔', '⭐'];
      const spin = Array.from({ length: 3 }, () => icons[Math.floor(Math.random() * icons.length)]);
      const win = spin.every(s => s === spin[0]);
      if (win) {
        delta = Math.floor(bet * 3 * streakMult);
        result = `Slots: ${spin.join(' ')} - Jackpot!`;
      } else {
        delta = -bet;
        result = `Slots: ${spin.join(' ')} - You lose.`;
      }
    } else if (game === 'bomb') {
      let multiplier = 1;
      let safe = true;
      for (let i = 0; i < 5; i++) {
        if (Math.random() < 0.15) {
          safe = false;
          break;
        }
        multiplier += 0.5;
      }
      if (safe) {
        delta = Math.floor(bet * multiplier * streakMult);
        result = `Bomb: You risked and won ${delta} coins with x${multiplier.toFixed(1)} multiplier!`;
      } else {
        delta = -bet;
        result = `Bomb: 💣 You hit a bomb and lost everything.`;
      }
    }

    const upd = { coins: data.coins + delta, xp: data.xp + 5 };
    await supa.from('users').update(upd).eq('user_id', uid);

    return inter.reply(`${result}\nYou ${delta >= 0 ? 'gained' : 'lost'} ${Math.abs(delta)} coins.`);
  }
});

bot.on('messageCreate', async msg => {
  if (msg.author.bot) return;
  const uid = msg.author.id;
  const { data } = await supa.from('users').select().eq('user_id', uid).single();
  const xpGain = 2 * (1 + data.streak * 0.01);
  const newXp = data.xp + Math.floor(xpGain);
  const newLvl = Math.floor(Math.sqrt(newXp / 10)) + 1;
  await supa.from('users')
    .update({ xp: newXp, lvl: newLvl })
    .eq('user_id', uid);
});

bot.login(process.env.DISCORD_TOKEN);
