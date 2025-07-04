import { Client, GatewayIntentBits, SlashCommandBuilder, PermissionsBitField } from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });

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
      user_id: uid,
      coins: 0,
      xp: 0,
      lvl: 1,
      streak: 1,
      last_active: now
    }).select().single();
    userData = insertResult.data;
  } else if (userData.last_active !== now) {
    const yesterday = new Date(Date.now() - 86400e3).toISOString().split('T')[0];
    const newStreak = userData.last_active === yesterday ? userData.streak + 1 : 1;
    await supa.from('users').update({ streak: newStreak, last_active: now }).eq('user_id', uid);
    userData.streak = newStreak;
  }

  // HELP COMMAND
  if (inter.commandName === 'help') {
    return inter.reply({
      embeds: [{
        title: '📘 Help Menu',
        description: `
**/balance** – View your XP, level, and streak  
**/leaderboard** – Show top 10 users  
**/commandable [role]** – Set reward role for #1 user *(Admin)*  
**/setmessagepoints [amount]** – Set XP per message *(Admin)*
        `,
        color: 0x7a5cfa
      }]
    });
  }

  // BALANCE COMMAND
  if (inter.commandName === 'balance') {
    return inter.reply(`🌟 XP: ${userData.xp}, Level: ${userData.lvl}, Streak: ${userData.streak} days`);
  }

  // SET XP POINTS PER MESSAGE
  if (inter.commandName === 'setmessagepoints') {
    if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Only admins can do that.');
    const amt = inter.options.getInteger('amount');
    await supa.from('settings').upsert({ guild_id: gid, message_points: amt });
    return inter.reply(`✅ Message XP set to ${amt} per message.`);
  }

  // SET TOP USER ROLE
  if (inter.commandName === 'role') {
    if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Only admins can do that.');
    const role = inter.options.getRole('role');
    await supa.from('leaderboard_config').upsert({ guild_id: gid, role_id: role.id });
    return inter.reply(`🎖️ Role **${role.name}** will now be given to the top user.`);
  }

  // LEADERBOARD
  if (inter.commandName === 'leaderboard') {
    const { data: top } = await supa.from('users').select().order('xp', { ascending: false }).limit(10);
    const members = await inter.guild.members.fetch();
    const list = top.map((u, i) => {
      const name = members.get(u.user_id)?.displayName || `<@${u.user_id}>`;
      return `**${i + 1}.** ${name} – ${u.xp} XP`;
    }).join('\n');

    // Auto assign role to top user
    const { data: config } = await supa.from('leaderboard_config').select().eq('guild_id', gid).single();
    if (config) {
      const topUserId = top[0]?.user_id;
      const oldUserId = config.last_top_user;

      if (topUserId !== oldUserId && topUserId) {
        const role = inter.guild.roles.cache.get(config.role_id);
        if (role) {
          if (oldUserId) {
            const oldMember = inter.guild.members.cache.get(oldUserId);
            if (oldMember?.roles.cache.has(role.id)) await oldMember.roles.remove(role);
          }
          const newMember = inter.guild.members.cache.get(topUserId);
          if (newMember && !newMember.roles.cache.has(role.id)) await newMember.roles.add(role);

          await supa.from('leaderboard_config').update({ last_top_user: topUserId }).eq('guild_id', gid);
        }
      }
    }

    return inter.reply({ embeds: [{ title: "🏆 Top 10 Leaderboard", description: list, color: 0xffcc00 }] });
  }
});

// On every message, award XP
bot.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guild) return;

  const uid = msg.author.id;
  const gid = msg.guild.id;
  const now = new Date().toISOString().split('T')[0];

  let { data: user } = await supa.from('users').select().eq('user_id', uid).single();
  if (!user) {
    const insertResult = await supa.from('users').insert({
      user_id: uid,
      coins: 0,
      xp: 0,
      lvl: 1,
      streak: 1,
      last_active: now
    }).select().single();
    user = insertResult.data;
  }

  const { data: setting } = await supa.from('settings').select().eq('guild_id', gid).single();
  const xpGain = setting?.message_points || 2;
  const newXp = user.xp + xpGain;
  const newLvl = Math.floor(Math.sqrt(newXp / 10)) + 1;

  await supa.from('users').update({ xp: newXp, lvl: newLvl, last_active: now }).eq('user_id', uid);
});

// Login the bot
bot.login(process.env.DISCORD_TOKEN);
