// index.js (ESM version, requires "type": "module" in package.json)
import { Client, GatewayIntentBits, SlashCommandBuilder, PermissionsBitField } from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';
import cron from 'node-cron';
dotenv.config();

// Load configs
const settingsConfig = JSON.parse(fs.readFileSync('./config/settings.json', 'utf8'));
const decayConfig = JSON.parse(fs.readFileSync('./config/decay.json', 'utf8'));

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// Register Slash Commands
bot.on('ready', async () => {
  const cmds = [
    new SlashCommandBuilder().setName('balance').setDescription('Show your stats'),
    new SlashCommandBuilder().setName('help').setDescription('Show help command'),
    new SlashCommandBuilder().setName('leaderboard').setDescription('Show top 10 users'),
    new SlashCommandBuilder().setName('role')
      .addRoleOption(opt => opt.setName('role').setDescription('Role to assign to top user').setRequired(true))
      .setDescription('Set the top user reward role (admin only)'),
    new SlashCommandBuilder().setName('setmessagepoints')
      .addIntegerOption(opt => opt.setName('amount').setDescription('XP points per message').setRequired(true))
      .setDescription('Set how much XP each message gives (admin only)')
  ].map(c => c.toJSON());

  await bot.application.commands.set(cmds);
  console.log('✅ Bot is ready');
});

// Slash Command Handling
bot.on('interactionCreate', async inter => {
  if (!inter.isChatInputCommand()) return;
  const uid = inter.user.id;
  const gid = inter.guildId;
  const now = new Date().toISOString().split('T')[0];

  // Ensure user exists
  let { data: userData } = await supa.from('users').select().eq('user_id', uid).single();
  if (!userData) {
    const insertResult = await supa.from('users').insert({
      user_id: uid, coins: 0, xp: 0, lvl: 1, streak: 1, last_active: now
    }).select().single();
    userData = insertResult.data;
  } else if (userData.last_active !== now) {
    const yesterday = new Date(Date.now() - 86400e3).toISOString().split('T')[0];
    const newStreak = userData.last_active === yesterday ? userData.streak + 1 : 1;
    await supa.from('users').update({ streak: newStreak, last_active: now }).eq('user_id', uid);
    userData.streak = newStreak;
  }

  if (inter.commandName === 'help') {
    return inter.reply({
      embeds: [{
        title: '📘 Help Menu',
        description: `
**/balance** – View your XP, level, and streak  
**/leaderboard** – Show top 10 users  
**/role [role]** – Set reward role for #1 user *(Admin)*  
**/setmessagepoints [amount]** – Set XP per message *(Admin)*  

📈 Leveling is based on sqrt(xp/10)+1  
📉 XP decays after ${decayConfig.days_before_decay} days of inactivity by ${decayConfig.percentage_decay * 100}%
❌ No XP gain in excluded channels
`,
        color: 0x7a5cfa
      }]
    });
  }

  if (inter.commandName === 'balance') {
    return inter.reply(`🌟 XP: ${userData.xp}, Level: ${userData.lvl}, Streak: ${userData.streak} days`);
  }

  if (inter.commandName === 'setmessagepoints') {
    if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Only admins can do that.');
    const amt = inter.options.getInteger('amount');
    await supa.from('settings').upsert({ guild_id: gid, message_points: amt });
    return inter.reply(`✅ Message XP set to ${amt} per message.`);
  }

  if (inter.commandName === 'role') {
    if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Only admins can do that.');
    const role = inter.options.getRole('role');
    await supa.from('leaderboard_config').upsert({ guild_id: gid, role_id: role.id });
    return inter.reply(`🎖️ Role **${role.name}** will now be given to the top user.`);
  }

  if (inter.commandName === 'leaderboard') {
    const { data: top } = await supa.from('users').select().order('xp', { ascending: false }).limit(10);
    const members = await inter.guild.members.fetch();
    const list = top.map((u, i) => {
      const name = members.get(u.user_id)?.displayName || `<@${u.user_id}>`;
      return `**${i + 1}.** ${name} – ${u.xp} XP`;
    }).join('\n');

    const { data: config } = await supa.from('leaderboard_config').select().eq('guild_id', gid).single();
    if (config) {
      const topUserId = top[0]?.user_id;
      const oldUserId = config.last_top_user;
      const role = inter.guild.roles.cache.get(config.role_id);

      if (topUserId !== oldUserId && topUserId && role) {
        if (oldUserId) {
          const oldMember = inter.guild.members.cache.get(oldUserId);
          if (oldMember?.roles.cache.has(role.id)) await oldMember.roles.remove(role);
        }
        const newMember = inter.guild.members.cache.get(topUserId);
        if (newMember && !newMember.roles.cache.has(role.id)) await newMember.roles.add(role);
        await supa.from('leaderboard_config').update({ last_top_user: topUserId }).eq('guild_id', gid);
      }
    }

    return inter.reply({
      embeds: [{
        title: "🏆 Top 10 Leaderboard",
        description: list,
        color: 0xffcc00
      }]
    });
  }
});

// Award XP on message
bot.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guild) return;
  const uid = msg.author.id;
  const gid = msg.guild.id;
  const cid = msg.channel.id;
  const now = new Date().toISOString().split('T')[0];

  const { data: setting } = await supa.from('settings').select().eq('guild_id', gid).single();

  let excluded = [];


    try {
      excluded = JSON.parse(process.env.DEFAULT_EXCLUDED_CHANNELS || '[]');
    } catch {
      excluded = [];
    }

// Make sure all values are strings for comparison
  excluded = excluded.map(id => id.toString());

  console.log(excluded);
  if (excluded.includes(cid)) return;

  const xpGain = setting?.message_points ??
    parseInt(process.env.DEFAULT_MESSAGE_POINTS) ??
    settingsConfig.default_message_points;

  let { data: user } = await supa.from('users').select().eq('user_id', uid).single();
  if (!user) {
    const res = await supa.from('users').insert({
      user_id: uid, xp: 0, lvl: 1, coins: 0, streak: 1, last_active: now
    }).select().single();
    user = res.data;
  }

  const newXp = user.xp + xpGain;
  const newLvl = Math.floor(Math.sqrt(newXp / 10)) + 1;
  const leveledUp = newLvl > user.lvl;

  await supa.from('users').update({
    xp: newXp, lvl: newLvl, last_active: now
  }).eq('user_id', uid);

  if (leveledUp) msg.channel.send(`🎉 <@${uid}> leveled up to **${newLvl}**!`);
});

// Decay scheduler (daily)
cron.schedule('0 4 * * *', async () => {
  const today = new Date();
  const cutoff = new Date(today - decayConfig.days_before_decay * 86400e3);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const { data: users } = await supa.from('users').select();
  for (const u of users) {
    if (u.last_active < cutoffStr) {
      const newXp = Math.floor(u.xp * (1 - decayConfig.percentage_decay));
      const newLvl = Math.floor(Math.sqrt(newXp / 10)) + 1;
      await supa.from('users').update({ xp: newXp, lvl: newLvl }).eq('user_id', u.user_id);
    }
  }
});

// Login
bot.login(process.env.DISCORD_TOKEN);
