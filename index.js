// index.js (ESM version, requires "type": "module" in package.json)
import { Client, GatewayIntentBits, SlashCommandBuilder, PermissionsBitField } from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';
import cron from 'node-cron';
dotenv.config();

// Load fallback configs
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

// Slash command registration
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
      .setDescription('Set how much XP each message gives (admin only)'),
    new SlashCommandBuilder().setName('allowchannel')
      .addStringOption(opt => opt.setName('channelid').setDescription('Channel ID').setRequired(true))
      .addStringOption(opt => opt.setName('serverid').setDescription('Server ID').setRequired(true))
      .setDescription('Allow a channel for XP tracking (admin only)')
  ].map(c => c.toJSON());

  await bot.application.commands.set(cmds);
  console.log('✅ Bot is ready');
});

// Handle slash commands
bot.on('interactionCreate', async inter => {
  if (!inter.isChatInputCommand()) return;
  const uid = inter.user.id;
  const gid = inter.guildId;
  const now = new Date().toISOString().split('T')[0];

  if (inter.commandName === 'help') {
    const { data: setting } = await supa.from('settings').select().eq('guild_id', gid).single();
    const { data: decay } = await supa.from('decay_config').select().eq('guild_id', gid).single();
    const msgPoints = setting?.message_points ?? parseInt(process.env.DEFAULT_MESSAGE_POINTS) ?? settingsConfig.default_message_points;
    const daysDecay = decay?.days_before_decay ?? 7;
    const percentDecay = decay?.percentage_decay ?? 0.2;

    const { data: allowed } = await supa.from('allowed_channels').select().eq('guild_id', gid);
    const allowedList = allowed.map(ch => `<#${ch.channel_id}>`).join(', ') || '*None configured*';

    return inter.reply({
      embeds: [{
        title: '📘 Help Menu',
        description: `
**/balance** – View your XP, level, and streak  
**/leaderboard** – Show top 10 users  
**/role [role]** – Set reward role for #1 user *(Admin)*  
**/setmessagepoints [amount]** – Set XP gain per message *(Admin)*  
**/allowchannel** – Add a channel to XP tracking *(Admin)*

📤 XP Gain: **${msgPoints} XP** per message  
📉 Decay: **${percentDecay * 100}%** after **${daysDecay} days** inactivity  
📺 Allowed Channels: ${allowedList}
        `,
        color: 0x7a5cfa
      }]
    });
  }

  if (inter.commandName === 'allowchannel') {
    if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Admin only');
    const channel_id = inter.options.getString('channelid');
    const guild_id = inter.options.getString('serverid');
    await supa.from('allowed_channels').upsert({ guild_id, channel_id });
    return inter.reply(`✅ Channel <#${channel_id}> allowed for XP.`);
  }
});

// XP system
bot.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guild) return;
  const uid = msg.author.id;
  const gid = msg.guild.id;
  const cid = msg.channel.id;
  const now = new Date().toISOString().split('T')[0];

  const { data: allowed } = await supa.from('allowed_channels').select('channel_id').eq('guild_id', gid);
  if (!allowed.map(c => c.channel_id).includes(cid)) return;

  const { data: setting } = await supa.from('settings').select().eq('guild_id', gid).single();
  const xpGain = setting?.message_points ?? parseInt(process.env.DEFAULT_MESSAGE_POINTS) ?? settingsConfig.default_message_points;

  let { data: user } = await supa.from('users').select().eq('user_id', uid).single();
  if (!user) {
    const res = await supa.from('users').insert({ user_id: uid, xp: xpGain, lvl: 1, streak: 1, last_active: now }).select().single();
    user = res.data;
  } else {
    const newXp = user.xp + xpGain;
    const newLvl = Math.floor(Math.sqrt(newXp / 10)) + 1;
    const leveledUp = newLvl > user.lvl;
    await supa.from('users').update({ xp: newXp, lvl: newLvl, last_active: now }).eq('user_id', uid);
    if (leveledUp) msg.channel.send(`🎉 <@${uid}> leveled up to **${newLvl}**!`);
  }
});

// XP Decay cron
cron.schedule('0 4 * * *', async () => {
  const { data: decaySettings } = await supa.from('decay_config').select();
  const users = (await supa.from('users').select()).data;
  const today = new Date();

  for (const setting of decaySettings) {
    const cutoff = new Date(today - setting.days_before_decay * 86400e3).toISOString().split('T')[0];
    const targetUsers = users.filter(u => u.last_active < cutoff);
    for (const u of targetUsers) {
      const newXp = Math.floor(u.xp * (1 - setting.percentage_decay));
      const newLvl = Math.floor(Math.sqrt(newXp / 10)) + 1;
      await supa.from('users').update({ xp: newXp, lvl: newLvl }).eq('user_id', u.user_id);
    }
  }
});

bot.login(process.env.DISCORD_TOKEN);
