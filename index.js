// index.js (ESM version, requires "type": "module" in package.json)
import { Client, GatewayIntentBits, SlashCommandBuilder, PermissionsBitField } from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';
import cron from 'node-cron';
dotenv.config();

// Load settings config
const settingsConfig = JSON.parse(fs.readFileSync('./config/settings.json', 'utf8'));

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// Slash Commands
bot.on('ready', async () => {
  const cmds = [
    new SlashCommandBuilder().setName('balance').setDescription('Show your stats'),
    new SlashCommandBuilder().setName('help').setDescription('Show help and settings info'),
    new SlashCommandBuilder().setName('leaderboard').setDescription('Show top 10 users'),
    new SlashCommandBuilder().setName('role')
      .addRoleOption(opt => opt.setName('role').setDescription('Top user reward role').setRequired(true))
      .setDescription('Set reward role for top user (admin only)'),
    new SlashCommandBuilder().setName('setmessagepoints')
      .addIntegerOption(opt => opt.setName('amount').setDescription('XP per message').setRequired(true))
      .setDescription('Set message XP (admin only)')
  ].map(c => c.toJSON());

  await bot.application.commands.set(cmds);
  console.log('✅ Bot is ready');
});

bot.on('interactionCreate', async inter => {
  if (!inter.isChatInputCommand()) return;
  const uid = inter.user.id;
  const gid = inter.guildId;
  const now = new Date().toISOString().split('T')[0];

  // Ensure user exists
  let { data: userData } = await supa.from('users').select().eq('user_id', uid).single();
  if (!userData) {
    const insert = await supa.from('users').insert({
      user_id: uid, coins: 0, xp: 0, lvl: 1, streak: 1, last_active: now
    }).select().single();
    userData = insert.data;
  } else if (userData.last_active !== now) {
    const yesterday = new Date(Date.now() - 86400e3).toISOString().split('T')[0];
    const newStreak = userData.last_active === yesterday ? userData.streak + 1 : 1;
    await supa.from('users').update({ streak: newStreak, last_active: now }).eq('user_id', uid);
    userData.streak = newStreak;
  }

  if (inter.commandName === 'help') {
    const { data: setting } = await supa.from('settings').select().eq('guild_id', gid).single();
    const xp = setting?.message_points ?? settingsConfig.default_message_points;
    const { data: allowed } = await supa.from('allowed_channels').select('channel_id').eq('guild_id', gid);
    const allowedList = allowed?.map(c => `<#${c.channel_id}>`).join(', ') || 'None';

    return inter.reply({
      embeds: [{
        title: '📘 Help & Bot Settings',
        description: `
**/balance** – View your XP, level, and streak  
**/leaderboard** – Top 10 users  
**/role [role]** – Set top user reward *(Admin only)*  
**/setmessagepoints [amount]** – Set XP gain per message *(Admin only)*  

🛠️ **Bot Settings**  
• XP per message: \`${xp}\`  
• Allowed channels for XP: ${allowedList}  
📉 XP decays 5% after 7 days of inactivity (SQL-handled)
        `,
        color: 0x7a5cfa
      }]
    });
  }

  if (inter.commandName === 'balance') {
    return inter.reply(`🌟 XP: ${userData.xp}, Level: ${userData.lvl}, Streak: ${userData.streak} days`);
  }

  if (inter.commandName === 'setmessagepoints') {
    if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Admin only.');
    const amt = inter.options.getInteger('amount');
    await supa.from('settings').upsert({ guild_id: gid, message_points: amt });
    return inter.reply(`✅ Message XP set to ${amt}`);
  }

  if (inter.commandName === 'role') {
    if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Admin only.');
    const role = inter.options.getRole('role');
    await supa.from('leaderboard_config').upsert({ guild_id: gid, role_id: role.id });
    return inter.reply(`🎖️ Role **${role.name}** assigned to top user`);
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

// Award XP on valid message
bot.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guild) return;
  const uid = msg.author.id;
  const gid = msg.guild.id;
  const cid = msg.channel.id;
  const now = new Date().toISOString().split('T')[0];

  const { data: setting } = await supa.from('settings').select().eq('guild_id', gid).single();
  const { data: allowed } = await supa.from('allowed_channels').select('channel_id').eq('guild_id', gid);
  const allowedChannels = allowed?.map(c => c.channel_id) ?? [];

  if (!allowedChannels.includes(cid)) return;

  const xpGain = setting?.message_points ?? parseInt(process.env.DEFAULT_MESSAGE_POINTS) ?? settingsConfig.default_message_points;

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

// SQL-triggered decay via cron
cron.schedule('0 4 * * *', async () => {
  try {
    const { error } = await supa.rpc('apply_xp_decay');
    if (error) console.error('❌ Decay error:', error.message);
    else console.log('✅ SQL XP decay executed');
  } catch (err) {
    console.error('❌ Cron error:', err.message);
  }
});

bot.login(process.env.DISCORD_TOKEN);
