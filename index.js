// index.js
import { Client, GatewayIntentBits, SlashCommandBuilder, PermissionsBitField } from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import cron from 'node-cron';
dotenv.config();

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });

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
    new SlashCommandBuilder().setName('excludechannel')
      .addChannelOption(opt => opt.setName('channel').setDescription('Exclude XP gain in this channel').setRequired(true))
      .setDescription('Exclude channel from XP (admin only)')
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
    const insertResult = await supa.from('users').insert({ user_id: uid, coins: 0, xp: 0, lvl: 1, streak: 1, last_active: now }).select().single();
    userData = insertResult.data;
  } else if (userData.last_active !== now) {
    const yesterday = new Date(Date.now() - 86400e3).toISOString().split('T')[0];
    const newStreak = userData.last_active === yesterday ? userData.streak + 1 : 1;
    await supa.from('users').update({ streak: newStreak, last_active: now }).eq('user_id', uid);
    userData.streak = newStreak;
  }

  if (inter.commandName === 'help') {
    return inter.reply({ embeds: [{
      title: '📘 Help Menu',
      description: `**/balance** – View your XP, level, streak, and badges\n**/leaderboard** – Show top 10 users\n**/role [role]** – Set reward role for #1 user *(Admin)*\n**/setmessagepoints [amount]** – Set XP per message *(Admin)*\n**/excludechannel [channel]** – Ignore XP in selected channel *(Admin)*`,
      color: 0x7a5cfa
    }] });
  }

  if (inter.commandName === 'balance') {
    const { data: badges } = await supa.from('badges').select('badge').eq('user_id', uid);
    const badgeList = badges?.map(b => b.badge).join(' ') || 'None';
    return inter.reply(`🌟 XP: ${userData.xp}, Level: ${userData.lvl}, Streak: ${userData.streak} days\n🏅 Badges: ${badgeList}`);
  }

  if (inter.commandName === 'setmessagepoints') {
    if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Admin only.');
    const amt = inter.options.getInteger('amount');
    await supa.from('settings').upsert({ guild_id: gid, message_points: amt });
    return inter.reply(`✅ Message XP set to ${amt}.`);
  }

  if (inter.commandName === 'role') {
    if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Admin only.');
    const role = inter.options.getRole('role');
    await supa.from('leaderboard_config').upsert({ guild_id: gid, role_id: role.id });
    return inter.reply(`🎖️ Role **${role.name}** set for top user.`);
  }

  if (inter.commandName === 'excludechannel') {
    if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Admin only.');
    const ch = inter.options.getChannel('channel');
    await supa.from('excluded_channels').upsert({ guild_id: gid, channel_id: ch.id });
    return inter.reply(`🚫 XP disabled in ${ch}.`);
  }

  if (inter.commandName === 'leaderboard') {
    const { data: top } = await supa.from('users').select().order('xp', { ascending: false }).limit(10);
    const members = await inter.guild.members.fetch();
    const list = top.map((u, i) => `**${i + 1}.** ${members.get(u.user_id)?.displayName || `<@${u.user_id}>`} – ${u.xp} XP`).join('\n');

    const { data: config } = await supa.from('leaderboard_config').select().eq('guild_id', gid).single();
    if (config) {
      const topUserId = top[0]?.user_id;
      const oldUserId = config.last_top_user;
      const role = inter.guild.roles.cache.get(config.role_id);

      if (topUserId !== oldUserId && role) {
        if (oldUserId) {
          const oldMem = inter.guild.members.cache.get(oldUserId);
          if (oldMem?.roles.cache.has(role.id)) await oldMem.roles.remove(role);
        }
        const newMem = inter.guild.members.cache.get(topUserId);
        if (newMem && !newMem.roles.cache.has(role.id)) await newMem.roles.add(role);
        await supa.from('leaderboard_config').update({ last_top_user: topUserId }).eq('guild_id', gid);
      }
    }
    return inter.reply({ embeds: [{ title: "🏆 Leaderboard", description: list, color: 0xffcc00 }] });
  }
});

bot.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guild) return;

  const uid = msg.author.id;
  const gid = msg.guild.id;
  const now = new Date().toISOString().split('T')[0];

  const { data: excluded } = await supa.from('excluded_channels').select().eq('guild_id', gid).eq('channel_id', msg.channel.id).maybeSingle();
  if (excluded) return;

  let { data: user } = await supa.from('users').select().eq('user_id', uid).single();
  if (!user) {
    const insert = await supa.from('users').insert({ user_id: uid, coins: 0, xp: 0, lvl: 1, streak: 1, last_active: now }).select().single();
    user = insert.data;
  }

  const { data: setting } = await supa.from('settings').select().eq('guild_id', gid).single();
  const xpGain = setting?.message_points || 2;
  const newXp = user.xp + xpGain;
  const newLvl = Math.floor(Math.sqrt(newXp / 10)) + 1;
  const levelUp = newLvl > user.lvl;

  await supa.from('users').update({ xp: newXp, lvl: newLvl, last_active: now }).eq('user_id', uid);

  // Dynamic level-up message
  if (levelUp) msg.reply(`🎉 Congrats ${msg.author.username}, you leveled up to ${newLvl}!`);

  // Badge logic
  const badges = [];
  if (newLvl >= 10) badges.push('🥉');
  if (newXp >= 1000) badges.push('💎');
  if (user.streak >= 7) badges.push('🔥');
  for (const b of badges) {
    await supa.from('badges').upsert({ user_id: uid, badge: b });
  }
});

// XP Decay
cron.schedule('0 0 * * *', async () => {
  const { data: users } = await supa.from('users').select();
  const today = new Date();
  for (const u of users) {
    const last = new Date(u.last_active);
    const diff = Math.floor((today - last) / (1000 * 60 * 60 * 24));
    if (diff >= 3) {
      const decay = Math.floor(u.xp * 0.05);
      const newXp = Math.max(u.xp - decay, 0);
      const newLvl = Math.floor(Math.sqrt(newXp / 10)) + 1;
      await supa.from('users').update({ xp: newXp, lvl: newLvl }).eq('user_id', u.user_id);
    }
  }
});

bot.login(process.env.DISCORD_TOKEN);
