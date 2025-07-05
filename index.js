import { Client, GatewayIntentBits, SlashCommandBuilder, PermissionsBitField } from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';
import cron from 'node-cron';
dotenv.config();

// Load fallback config
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

// Slash Command Setup
bot.on('ready', async () => {
  const cmds = [
    new SlashCommandBuilder().setName('balance').setDescription('Show your stats'),
    new SlashCommandBuilder().setName('help').setDescription('Show help command'),
    new SlashCommandBuilder().setName('leaderboard').setDescription('Show top 10 users'),
    new SlashCommandBuilder().setName('setmessagepoints')
      .addIntegerOption(opt => opt.setName('amount').setDescription('XP per message').setRequired(true))
      .setDescription('Set XP gain per message (Admin)'),
    new SlashCommandBuilder().setName('allowchannel')
      .addChannelOption(opt => opt.setName('channel').setDescription('Channel to allow XP in').setRequired(true))
      .setDescription('Allow XP in this channel (Admin)'),
    new SlashCommandBuilder().setName('removechannel')
      .addChannelOption(opt => opt.setName('channel').setDescription('Remove channel from XP gain').setRequired(true))
      .setDescription('Disallow XP in this channel (Admin)'),
    new SlashCommandBuilder().setName('role')
      .addRoleOption(opt => opt.setName('role').setDescription('Role to assign to top user').setRequired(true))
      .setDescription('Set role reward for top user (Admin)')
  ].map(c => c.toJSON());

  await bot.application.commands.set(cmds);
  console.log('✅ Bot is ready');
});

// Slash Command Handler
bot.on('interactionCreate', async inter => {
  if (!inter.isChatInputCommand()) return;

  const uid = inter.user.id;
  const gid = inter.guildId;
  const now = new Date().toISOString().split('T')[0];

  // Ensure user exists
  let { data: userData } = await supa.from('users').select().eq('user_id', uid).single();
  if (!userData) {
    const res = await supa.from('users').insert({
      user_id: uid, coins: 0, xp: 0, lvl: 1, streak: 1, last_active: now
    }).select().single();
    userData = res.data;
  } else if (userData.last_active !== now) {
    const yesterday = new Date(Date.now() - 86400e3).toISOString().split('T')[0];
    const newStreak = userData.last_active === yesterday ? userData.streak + 1 : 1;
    await supa.from('users').update({ streak: newStreak, last_active: now }).eq('user_id', uid);
    userData.streak = newStreak;
  }

  if (inter.commandName === 'help') {
    const { data: setting } = await supa.from('settings').select().eq('guild_id', gid).single();
    const { data: allowed } = await supa.from('allowed_channels').select().eq('guild_id', gid);
    const { data: decay } = await supa.from('decay_config').select().eq('guild_id', gid).single();

    const allowedList = allowed?.map(a => `<#${a.channel_id}>`).join(', ') || '*None*';
    const msgPoints = setting?.message_points ?? process.env.DEFAULT_MESSAGE_POINTS ?? settingsConfig.default_message_points;
    const decayInfo = decay
      ? `🕒 XP decays after ${decay.days_before_decay} days by ${decay.percentage_decay * 100}%`
      : '🕒 No decay configured.';

    return inter.reply({
      embeds: [{
        title: '📘 Help Menu',
        description: `
**/balance** – View your XP, level, and streak  
**/leaderboard** – Show top 10 users  
**/role [role]** – Set reward role for #1 user *(Admin)*  
**/setmessagepoints [amount]** – Set XP gain per message *(Admin)*  
**/allowchannel [#channel]** – Allow XP in this channel *(Admin)*  
**/removechannel [#channel]** – Remove channel from XP gain *(Admin)*  

📊 Message XP per message: **${msgPoints}**
📺 Allowed XP channels: ${allowedList}
${decayInfo}
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
    return inter.reply(`✅ XP per message set to **${amt}**.`);
  }

  if (inter.commandName === 'allowchannel') {
    if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Only admins can do that.');
    const channel = inter.options.getChannel('channel');
    if (!channel.isTextBased()) return inter.reply('❌ Please select a text-based channel.');
    await supa.from('allowed_channels').upsert({ guild_id: gid, channel_id: channel.id });
    return inter.reply(`✅ XP now allowed in <#${channel.id}>`);
  }

  if (inter.commandName === 'removechannel') {
    if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Only admins can do that.');
    const channel = inter.options.getChannel('channel');
    await supa.from('allowed_channels').delete().eq('guild_id', gid).eq('channel_id', channel.id);
    return inter.reply(`🚫 XP disabled in <#${channel.id}>`);
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

// Message XP Handler
bot.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guild) return;
  const uid = msg.author.id;
  const gid = msg.guild.id;
  const cid = msg.channel.id;
  const now = new Date().toISOString().split('T')[0];

  const { data: allowed } = await supa.from('allowed_channels').select().eq('guild_id', gid);
  const allowedIds = allowed?.map(x => x.channel_id.toString()) ?? [];
  if (!allowedIds.includes(cid)) return;

  const { data: setting } = await supa.from('settings').select().eq('guild_id', gid).single();
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

// Decay Cron Job
cron.schedule('0 4 * * *', async () => {
  const today = new Date();
  const { data: guilds } = await supa.from('decay_config').select();

  const { data: users } = await supa.from('users').select();

  for (const g of guilds) {
    const cutoff = new Date(today - g.days_before_decay * 86400e3).toISOString().split('T')[0];

    for (const u of users) {
      if (u.last_active < cutoff) {
        const newXp = Math.floor(u.xp * (1 - g.percentage_decay));
        const newLvl = Math.floor(Math.sqrt(newXp / 10)) + 1;
        await supa.from('users').update({ xp: newXp, lvl: newLvl }).eq('user_id', u.user_id);
      }
    }
  }
});

bot.login(process.env.DISCORD_TOKEN);
