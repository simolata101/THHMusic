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
    new SlashCommandBuilder().setName('showstatus')
      .setDescription('Show user stats')
      .addUserOption(opt => opt.setName('user').setDescription('User to view')),
    new SlashCommandBuilder().setName('help').setDescription('Show help command'),
    new SlashCommandBuilder().setName('leaderboard').setDescription('Show top 10 users'),
    new SlashCommandBuilder().setName('setmessagepoints')
      .addIntegerOption(opt => opt.setName('amount').setDescription('XP per message').setRequired(true))
      .setDescription('Set XP gain per message'),
    new SlashCommandBuilder().setName('allowchannel')
      .addChannelOption(opt => opt.setName('channel').setDescription('Channel to allow XP').setRequired(true))
      .setDescription('Allow XP in this channel'),
    new SlashCommandBuilder().setName('removechannel')
      .addChannelOption(opt => opt.setName('channel').setDescription('Channel to remove XP').setRequired(true))
      .setDescription('Remove XP in this channel'),
    new SlashCommandBuilder().setName('setrole')
      .addIntegerOption(opt => opt.setName('min').setDescription('Min level').setRequired(true))
      .addIntegerOption(opt => opt.setName('max').setDescription('Max level').setRequired(true))
      .addRoleOption(opt => opt.setName('role').setDescription('Role').setRequired(true))
      .setDescription('Set level range to assign role'),
    new SlashCommandBuilder().setName('removerole')
      .addRoleOption(opt => opt.setName('role').setDescription('Role to remove').setRequired(true))
      .setDescription('Remove assigned level role'),
    new SlashCommandBuilder().setName('setstreakconfig')
      .addIntegerOption(opt => opt.setName('days').setDescription('Days before decay').setRequired(true))
      .setDescription('Set XP decay streak config'),
    new SlashCommandBuilder().setName('setstreakmessages')
      .addIntegerOption(opt => opt.setName('count').setDescription('Messages per day to count streak').setRequired(true))
      .setDescription('Set required messages per day for streak'),
    new SlashCommandBuilder().setName('updatestreak').setDescription('Manually update all user streaks'),
    new SlashCommandBuilder().setName('setlevelupchannel')
      .addChannelOption(opt => opt.setName('channel').setDescription('Level-up message channel').setRequired(true))
      .setDescription('Set channel for level-up messages'),
  ].map(c => c.toJSON());

  await bot.application.commands.set(cmds);
  console.log('✅ Bot is ready');
});

bot.on('interactionCreate', async inter => {
  if (!inter.isChatInputCommand()) return;
  const uid = inter.user.id;
  const gid = inter.guildId;
  const now = new Date().toISOString().split('T')[0];

  const msgCount = await supa.from('daily_messages')
    .select('message_count')
    .eq('user_id', uid)
    .eq('guild_id', gid)
    .eq('date', now)
    .maybeSingle();

  const streakConf = await supa.from('streak_config')
    .select()
    .eq('guild_id', gid)
    .maybeSingle();
  const requiredMessages = streakConf?.data?.required_messages ?? 1;

  let { data: userData } = await supa.from('users').select().eq('user_id', uid).single();
  if (!userData) {
    const res = await supa.from('users').insert({
      user_id: uid, xp: 0, lvl: 1, streak: 1, last_active: now
    }).select().single();
    userData = res.data;
  } else {
    const yesterday = new Date(Date.now() - 86400e3).toISOString().split('T')[0];
    if (userData.last_active !== now && msgCount?.data?.message_count >= requiredMessages) {
      const newStreak = userData.last_active === yesterday ? userData.streak + 1 : 1;
      await supa.from('users').update({ streak: newStreak, last_active: now }).eq('user_id', uid);
      userData.streak = newStreak;
    }
  }

  const isAdmin = inter.member.permissions.has(PermissionsBitField.Flags.Administrator);

  switch (inter.commandName) {
    case 'showstatus': {
      const target = inter.options.getUser('user') || inter.user;
      const { data: u } = await supa.from('users').select().eq('user_id', target.id).single();
      if (!u) return inter.reply('❌ User not found.');
      return inter.reply(`📊 <@${target.id}> – XP: ${u.xp}, Level: ${u.lvl}, Streak: ${u.streak} days`);
    }

    case 'setstreakconfig':
      if (!isAdmin) return inter.reply('❌ Admins only.');
      await supa.from('decay_config').upsert({ guild_id: gid, days_before_decay: inter.options.getInteger('days'), percentage_decay: 0.1 });
      return inter.reply(`✅ Streak decay set.`);

    case 'setstreakmessages':
      if (!isAdmin) return inter.reply('❌ Admins only.');
      await supa.from('streak_config').upsert({ guild_id: gid, required_messages: inter.options.getInteger('count') });
      return inter.reply('✅ Required messages per day for streak updated.');

    case 'updatestreak': {
      const { data: allUsers } = await supa.from('users').select();
      for (const u of allUsers) {
        const countRes = await supa.from('daily_messages')
          .select('message_count')
          .eq('user_id', u.user_id)
          .eq('guild_id', gid)
          .eq('date', now)
          .single();
        const count = countRes?.data?.message_count || 0;
        if (u.last_active !== now && count >= requiredMessages) {
          const yesterday = new Date(Date.now() - 86400e3).toISOString().split('T')[0];
          const newStreak = u.last_active === yesterday ? u.streak + 1 : 1;
          await supa.from('users').update({ streak: newStreak, last_active: now }).eq('user_id', u.user_id);
        }
      }
      return inter.reply('✅ Streaks updated.');
    }

    case 'setlevelupchannel':
      if (!isAdmin) return inter.reply('❌ Admins only.');
      const channel = inter.options.getChannel('channel');
      await supa.from('levelup_channel').upsert({ guild_id: gid, channel_id: channel.id });
      return inter.reply(`✅ Level-up messages will be sent in <#${channel.id}>`);

    case 'setrole':
      if (!isAdmin) return inter.reply('❌ Admins only.');
      const min = inter.options.getInteger('min');
      const max = inter.options.getInteger('max');
      const role = inter.options.getRole('role');

      const { data: existing } = await supa.from('level_roles')
        .select()
        .eq('guild_id', gid);
      if (existing.some(r => !(max < r.min_level || min > r.max_level)))
        return inter.reply('❌ Overlapping level range exists.');
      await supa.from('level_roles').insert({ guild_id: gid, role_id: role.id, min_level: min, max_level: max });
      return inter.reply(`✅ Role ${role.name} assigned to level ${min}-${max}`);

    case 'removerole':
      if (!isAdmin) return inter.reply('❌ Admins only.');
      const rmRole = inter.options.getRole('role');
      await supa.from('level_roles').delete().eq('guild_id', gid).eq('role_id', rmRole.id);
      return inter.reply(`🗑️ Removed role ${rmRole.name} from level config.`);
  }
});

bot.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guild) return;
  const uid = msg.author.id;
  const gid = msg.guild.id;
  const cid = msg.channel.id;
  const now = new Date().toISOString().split('T')[0];

  // Allowed Channels
  const { data: allowed } = await supa.from('allowed_channels').select().eq('guild_id', gid);
  if (allowed.length && !allowed.map(a => a.channel_id).includes(cid)) return;

  // Message Point Gain
  const { data: setting } = await supa.from('settings').select().eq('guild_id', gid).single();
  const xpGain = setting?.message_points ?? parseInt(process.env.DEFAULT_MESSAGE_POINTS) ?? settingsConfig.default_message_points;

  const userRes = await supa.from('users').select().eq('user_id', uid).maybeSingle();
  let user = userRes?.data;
  if (!user) {
    const res = await supa.from('users').insert({
      user_id: uid, xp: 0, lvl: 1, coins: 0, streak: 1, last_active: now
    }).select().single();
    user = res.data;
  }

  // Log message for streak
  await supa.from('daily_messages')
    .upsert({ user_id: uid, guild_id: gid, date: now, message_count: 1 }, { onConflict: 'user_id,guild_id,date' })
    .select()
    .single()
    .then(({ data }) => {
      if (data) {
        return supa.from('daily_messages')
          .update({ message_count: data.message_count + 1 })
          .eq('user_id', uid).eq('guild_id', gid).eq('date', now);
      }
    });

  const newXp = user.xp + xpGain;
  const newLvl = Math.floor(Math.sqrt(newXp / 10)) + 1;
  const leveledUp = newLvl > user.lvl;

  await supa.from('users').update({
    xp: newXp, lvl: newLvl, last_active: now
  }).eq('user_id', uid);

  if (leveledUp) {
    const chanConf = await supa.from('levelup_channel').select().eq('guild_id', gid).maybeSingle();
    const ch = chanConf?.data?.channel_id;
    const msgTarget = ch ? msg.guild.channels.cache.get(ch) : msg.channel;
    msgTarget?.send(`🎉 <@${uid}> leveled up to **${newLvl}**!`);

    // Check for role assign
    const { data: roles } = await supa.from('level_roles').select().eq('guild_id', gid);
    for (const r of roles) {
      if (newLvl >= r.min_level && newLvl <= r.max_level) {
        const member = await msg.guild.members.fetch(uid);
        if (!member.roles.cache.has(r.role_id)) await member.roles.add(r.role_id);
      }
    }
  }
});

bot.login(process.env.DISCORD_TOKEN);
