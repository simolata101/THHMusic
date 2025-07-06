import { Client, GatewayIntentBits, SlashCommandBuilder, PermissionsBitField } from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';
import cron from 'node-cron';
dotenv.config();

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

bot.on('ready', async () => {
  const cmds = [
    new SlashCommandBuilder().setName('showstatus').setDescription('Show your or another user\'s stats')
      .addUserOption(opt => opt.setName('user').setDescription('User to show')),
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
    new SlashCommandBuilder().setName('setrole')
      .addRoleOption(opt => opt.setName('role').setDescription('Role to assign').setRequired(true))
      .addIntegerOption(opt => opt.setName('minlevel').setDescription('Min level').setRequired(true))
      .addIntegerOption(opt => opt.setName('maxlevel').setDescription('Max level').setRequired(true))
      .setDescription('Set auto role based on level range (Admin)'),
    new SlashCommandBuilder().setName('removerole')
      .addIntegerOption(opt => opt.setName('minlevel').setDescription('Min level of range').setRequired(true))
      .addIntegerOption(opt => opt.setName('maxlevel').setDescription('Max level of range').setRequired(true))
      .setDescription('Remove set level role range (Admin)'),
    new SlashCommandBuilder().setName('setstreakconfig')
      .addIntegerOption(opt => opt.setName('reset_after_days').setDescription('Days to reset streak').setRequired(true))
      .setDescription('Set streak reset policy (Admin)'),
    new SlashCommandBuilder().setName('updatestreak').setDescription('Force streak update now'),
    new SlashCommandBuilder().setName('setlevelupchannel')
      .addChannelOption(opt => opt.setName('channel').setDescription('Channel for level-up messages').setRequired(true))
      .setDescription('Set level-up announcement channel (Admin)')
  ].map(c => c.toJSON());

  await bot.application.commands.set(cmds);
  console.log('✅ Bot is ready');
});

bot.on('interactionCreate', async inter => {
  if (!inter.isChatInputCommand()) return;
  const uid = inter.user.id;
  const gid = inter.guildId;
  const now = new Date().toISOString().split('T')[0];

  let { data: userData } = await supa.from('users').select().eq('user_id', uid).single();
  if (!userData) {
    const res = await supa.from('users').insert({
      user_id: uid, coins: 0, xp: 0, lvl: 1, streak: 1, last_active: now
    }).select().single();
    userData = res.data;
  }

  if (inter.commandName === 'showstatus') {
    const user = inter.options.getUser('user') || inter.user;
    const { data } = await supa.from('users').select().eq('user_id', user.id).single();
    if (!data) return inter.reply('❌ No data found.');
    return inter.reply(`🌟 XP: ${data.xp}, Level: ${data.lvl}, Streak: ${data.streak} days`);
  }

  if (inter.commandName === 'setrole') {
    if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Only admins.');
    const role = inter.options.getRole('role');
    const min = inter.options.getInteger('minlevel');
    const max = inter.options.getInteger('maxlevel');
    const { data: conflict } = await supa.from('level_roles').select().eq('guild_id', gid);
    if (conflict?.some(r => !(r.max_level < min || r.min_level > max)))
      return inter.reply('❌ Overlapping range.');
    await supa.from('level_roles').insert({ guild_id: gid, role_id: role.id, min_level: min, max_level: max });
    return inter.reply(`✅ Role set for levels ${min}-${max}.`);
  }

  if (inter.commandName === 'removerole') {
    if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Only admins.');
    const min = inter.options.getInteger('minlevel');
    const max = inter.options.getInteger('maxlevel');
    await supa.from('level_roles').delete().eq('guild_id', gid).eq('min_level', min).eq('max_level', max);
    return inter.reply(`🗑️ Removed role range ${min}-${max}.`);
  }

  if (inter.commandName === 'setstreakconfig') {
    if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Only admins.');
    const days = inter.options.getInteger('reset_after_days');
    await supa.from('streak_config').upsert({ guild_id: gid, reset_after_days: days });
    return inter.reply(`✅ Streak resets after ${days} day(s) of inactivity.`);
  }

  if (inter.commandName === 'updatestreak') {
    const { data: streakcfg } = await supa.from('streak_config').select().eq('guild_id', gid).single();
    const resetDays = streakcfg?.reset_after_days || 1;
    const yesterday = new Date(Date.now() - resetDays * 86400e3).toISOString().split('T')[0];
    if (userData.last_active !== now) {
      const newStreak = userData.last_active === yesterday ? userData.streak + 1 : 1;
      await supa.from('users').update({ streak: newStreak, last_active: now }).eq('user_id', uid);
      return inter.reply(`🔁 Streak updated: ${newStreak}`);
    }
    return inter.reply('⚠️ Streak already updated today.');
  }

  if (inter.commandName === 'setlevelupchannel') {
    if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Only admins.');
    const ch = inter.options.getChannel('channel');
    await supa.from('levelup_config').upsert({ guild_id: gid, channel_id: ch.id });
    return inter.reply(`📢 Level-up messages will be sent in <#${ch.id}>`);
  }
});

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

  const { data: streakcfg } = await supa.from('streak_config').select().eq('guild_id', gid).single();
  const resetDays = streakcfg?.reset_after_days || 1;
  const yesterday = new Date(Date.now() - resetDays * 86400e3).toISOString().split('T')[0];
  let newStreak = user.streak;
  if (user.last_active !== now) newStreak = user.last_active === yesterday ? user.streak + 1 : 1;

  const newXp = user.xp + xpGain;
  const newLvl = Math.floor(Math.sqrt(newXp / 10)) + 1;
  const leveledUp = newLvl > user.lvl;

  await supa.from('users').update({
    xp: newXp, lvl: newLvl, last_active: now, streak: newStreak
  }).eq('user_id', uid);

  if (leveledUp) {
    const { data: lvlupCfg } = await supa.from('levelup_config').select().eq('guild_id', gid).single();
    const ch = lvlupCfg ? msg.guild.channels.cache.get(lvlupCfg.channel_id) : msg.channel;
    if (ch?.isTextBased()) ch.send(`🎉 <@${uid}> leveled up to **${newLvl}**!`);

    const { data: roles } = await supa.from('level_roles').select().eq('guild_id', gid);
    const toAssign = roles?.find(r => newLvl >= r.min_level && newLvl <= r.max_level);
    if (toAssign) {
      const role = msg.guild.roles.cache.get(toAssign.role_id);
      const member = await msg.guild.members.fetch(uid);
      if (role && !member.roles.cache.has(role.id)) await member.roles.add(role);
    }
  }
});

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
