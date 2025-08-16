import {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    PermissionsBitField,
    AttachmentBuilder,
	EmbedBuilder
} from 'discord.js';
import {
    createClient
} from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';
import cron from 'node-cron';
import { createStatusCard } from './utils/createStatusCard.js';
dotenv.config();

const settingsConfig = JSON.parse(fs.readFileSync('./config/settings.json', 'utf8'));
const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const activeVoiceUsers = new Map(); // user_id => { guild_id, channel_id }
const roleCooldown = new Map(); // Map<channelId, timestamp>
const COOLDOWN_MS = 5_000; // 5 seconds cooldown per VC channel


const bot = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates 
    ]
});

// Slash Command Setup
bot.on('ready', async () => {
    const cmds = [
        new SlashCommandBuilder().setName('showstatus').setDescription('Show your stats')
        .addUserOption(opt => opt.setName('user').setDescription('User to view')),
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
        new SlashCommandBuilder().setName('removerole')
        .addRoleOption(opt => opt.setName('role').setDescription('Role to remove').setRequired(true))
        .setDescription('Remove an auto-assigned role (Admin)'),
        new SlashCommandBuilder().setName('setrole')
        .addIntegerOption(opt => opt.setName('min').setDescription('Min level').setRequired(true))
        .addIntegerOption(opt => opt.setName('max').setDescription('Max level').setRequired(true))
        .addRoleOption(opt => opt.setName('role').setDescription('Role to assign').setRequired(true))
        .setDescription('Set auto role by level range (Admin)'),
        new SlashCommandBuilder()
        .setName('setvcpoints')
        .addIntegerOption(opt => opt.setName('amount').setDescription('XP per minute in voice').setRequired(true))
        .setDescription('Set XP gain per minute for voice channels (Admin)'),
        new SlashCommandBuilder().setName('setstreakmessages')
        .addIntegerOption(opt =>
            opt.setName('amount')
            .setDescription('Messages per day to maintain streak')
            .setRequired(true))
        .setDescription('Set required messages per day for streaks (Admin)'),
	new SlashCommandBuilder()
		  .setName('givexp')
		  .setDescription('Give your XP points to another member')
		  .addUserOption(opt => opt.setName('user').setDescription('Member to give XP').setRequired(true))
		  .addIntegerOption(opt => opt.setName('amount').setDescription('Amount of XP to give').setRequired(true)),
	new SlashCommandBuilder().setName('setminimumpervc')
	  .setDescription('Set the minimum VC members and role to assign (Admin)')
	  .addIntegerOption(opt =>
	    opt.setName('min')
	      .setDescription('Minimum number of VC members required')
	      .setRequired(true)
	  )
	  .addRoleOption(opt =>
	    opt.setName('role')
	      .setDescription('Role to give when requirement is met')
	      .setRequired(true)
	  ),
        new SlashCommandBuilder().setName('setlevelupchannel')
        .addChannelOption(opt =>
            opt.setName('channel')
            .setDescription('Channel for level-up and role messages')
            .setRequired(true)
        )
        .setDescription('Set the channel for level-up and role notifications (Admin)')
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
    let {
        data: userData
    } = await supa.from('users').select().eq('user_id', uid).single();
    if (!userData) {
        const res = await supa.from('users').insert({
            user_id: uid,
            coins: 0,
            xp: 0,
            lvl: 1,
            streak: 1,
            last_active: now
        }).select().single();
        userData = res.data;
    } else {
        const yesterday = new Date(Date.now() - 86400e3).toISOString().split('T')[0];
        const newStreak = userData.last_active === yesterday ? userData.streak + 1 : (userData.last_active === now ? userData.streak : 1);
        await supa.from('users').update({
            streak: newStreak,
            last_active: now
        }).eq('user_id', uid);
        userData.streak = newStreak;
    }

    if (inter.commandName === 'showstatus') {
    const target = inter.options.getUser('user') || inter.user;
    const { data: targetData } = await supa.from('users').select().eq('user_id', target.id).single();
    const { data: streakCfg } = await supa.from('streak_config').select().eq('guild_id', gid).single();
    const { data: msgCount } = await supa.from('message_log').select('_count').eq('user_id', uid).eq('guild_id', gid).eq('date', now).single();

    const _count = msgCount?._count ?? 0;

    if (!targetData) return inter.reply(`❌ No data found for <@${target.id}>`);

    const buffer = await createStatusCard({
        username: target.username,
        xp: targetData.xp,
        lvl: targetData.lvl,
        streak: targetData.streak,
	countMsg: msgCount?._count ?? 0,
        reqMsg: streakCfg.required_message
    }, target.displayAvatarURL({ extension: 'png', size: 256 }));

    const attachment = new AttachmentBuilder(buffer, { name: 'status.png' });

    return inter.reply({
        content: `🌟 Status for <@${target.id}>`,
        files: [attachment]
    });
    }

      if (inter.commandName === 'setvcpoints') {
          if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return inter.reply('❌ Admin only.');
          }
        
          const amt = inter.options.getInteger('amount');
          await supa.from('settings').upsert({ guild_id: gid, vc_points: amt });
    
      return inter.reply(`🔊 Voice XP set to **${amt} XP/minute**.`);
    }


    if (inter.commandName === 'setstreakmessages') {
        if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return inter.reply('❌ Admin only.');
        }

        const amount = inter.options.getInteger('amount');
        await supa.from('streak_config').upsert({
            guild_id: gid,
            required_message: amount
        });

        return inter.reply(`📈 Required daily messages for streak set to **${amount}**.`);
    }

	if (inter.commandName === 'givexp') {
	  
	  const target = inter.options.getUser('user');
	  const amount = inter.options.getInteger('amount');
		// Restrict to specific user
	
	 if (target.id !== '776510853469175829') {
	    return inter.reply('❌ This command can only be used by **Haven Bot** for currency exchange.');
	  }
	
	  if (target.id === inter.user.id) 
	    return inter.reply('❌ You cannot give XP to yourself.');
	  if (amount <= 0) 
	    return inter.reply('❌ Amount must be greater than 0.');
	
	  // Fetch sender and receiver
	  const { data: sender } = await supa
	    .from('users')
	    .select()
	    .eq('user_id', inter.user.id)
	    .single();
	
	  let { data: receiver } = await supa
	    .from('users')
	    .select()
	    .eq('user_id', target.id)
	    .single();
	
	  if (!sender || sender.xp < amount) 
	    return inter.reply('❌ You do not have enough XP.');
	
	  // Store XP before transaction
	  const senderOldXp = sender.xp;
	  const receiverOldXp = receiver?.xp ?? 0;
	
	  // Create receiver if doesn't exist
	  if (!receiver) {
	    const res = await supa
	      .from('users')
	      .insert({
	        user_id: target.id,
	        coins: 0,
	        xp: 0,
	        lvl: 1,
	        streak: 1,
	        last_active: new Date().toISOString().split('T')[0]
	      })
	      .select()
	      .single();
	    receiver = res.data;
	  }
	
	  // Update sender XP
	  await supa
	    .from('users')
	    .update({
	      xp: senderOldXp - amount
	    })
	    .eq('user_id', inter.user.id);
	
	  // Update receiver XP and level
	  const receiverNewXp = receiverOldXp + amount;
	  const receiverNewLvl = Math.floor(Math.sqrt(receiverNewXp / 10)) + 1;
	
	  await supa
	    .from('users')
	    .update({
	      xp: receiverNewXp,
	      lvl: receiverNewLvl
	    })
	    .eq('user_id', target.id);
	
	  // Fetch new sender XP
	  const { data: senderAfter } = await supa
	    .from('users')
	    .select()
	    .eq('user_id', inter.user.id)
	    .single();
	
	  // Generate random reference number
	  const refNum = Math.floor(100000 + Math.random() * 900000); // 6 digit
	
	  // Create embed receipt
	  const receiptEmbed = new EmbedBuilder()
	    .setColor("#2ecc71") // green success color
	    .setTitle("📄 XP Transfer Receipt")
	    .setDescription("✅ Transaction completed successfully.")
	    .addFields(
	      { name: "🧾 Reference #", value: `\`${refNum}\``, inline: false },
	      { name: "👤 Sender", value: `<@${inter.user.id}>\n• XP Before: \`${senderOldXp}\`\n• XP After: \`${senderAfter.xp}\``, inline: true },
	      { name: "👤 Receiver", value: `<@${target.id}>\n• XP Before: \`${receiverOldXp}\`\n• XP After: \`${receiverNewXp}\``, inline: true },
	      { name: "💰 Amount Transferred", value: `\`${amount} XP\``, inline: false }
	    )
	    .setFooter({ text: `Timestamp: ${new Date().toLocaleString()}` })
	    .setTimestamp();
	
	  return inter.reply({ embeds: [receiptEmbed] });
	}


    if (inter.commandName === 'help') {
        const {
            data: setting
        } = await supa.from('settings').select().eq('guild_id', gid).single();
        const {
            data: streak_config
        } = await supa.from('streak_config').select().eq('guild_id', gid).single();
        const {
            data: allowed
        } = await supa.from('allowed_channels').select().eq('guild_id', gid);
        const {
            data: decay
        } = await supa.from('decay_config').select().eq('guild_id', gid).single();
        const {
            data: levelRoles
        } = await supa.from('level_roles').select().eq('guild_id', gid);
        const roleList = levelRoles?.map(r => {
            const roleObj = inter.guild.roles.cache.get(r.role_id);
            return roleObj ? `• ${roleObj.name}: Levels ${r.min_level}–${r.max_level}` : null;
        }).filter(Boolean).join('\n') || '*None set*';
        const levelUpChannel = setting?.levelup_channel ? `<#${setting.levelup_channel}>` : '*Not set*';

        const allowedList = allowed?.map(a => `<#${a.channel_id}>`).join(', ') || '*None*';
        const msgPoints = setting?.message_points ?? process.env.DEFAULT_MESSAGE_POINTS ?? settingsConfig.default_message_points;
        const decayInfo = decay ? `🕒 XP decays after ${decay.days_before_decay} days by ${decay.percentage_decay * 100}%` : '🕒 No decay configured.';

	const vcBoostRole = inter.guild.roles.cache.get(setting.vc_role_id);

	const status = vcBoostRole
	  ? `• Role: ${vcBoostRole.name}\n• Minimum VC Members: ${setting.vc_personqty}`
	  : '*VC role not found*';

        return inter.reply({
            embeds: [{
                title: '📘 Help Menu',
                description: `**/showstatus [user]** – View XP, level, streak  
      **/leaderboard** – Show top 10 users
      **/setrole [min] [max] [role]** – Auto-assign role
      **/removerole [role]** – Remove auto role
      **/setmessagepoints [amount]** – Set XP gain per message
      **/allowchannel [#channel]** – Allow XP in channel
      **/removechannel [#channel]** – Block XP in channel
      **/setlevelupchannel [#channel]** – Set level-up message channel
      **/setstreakmessages [amount]** – Set required daily messages for streak (Admin)
      **/setvcpoints [amount]** – Set XP per minute in voice chat
      **/setminimumpervc [min] [role] - Set minimum requirement per vc and the role assignment
      
      📊 XP per message: **${msgPoints}**  
      📺 Allowed XP channels: ${allowedList}  
      ${decayInfo}  
      🔥 Streak requirement: ${streak_config?.required_message ?? 'Not set'} message(s) per day
      🔊 VC XP per minute: **${setting?.vc_points ?? 'Not set'}**
      🔊 ${status}
      🎖️ **Level Roles:**  
      ${roleList}
      📢 Level-up messages: ${levelUpChannel}`,
                color: 0x7a5cfa
            }]
        });
    }

    if (inter.commandName === 'setmessagepoints') {
        if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Admin only.');
        const amt = inter.options.getInteger('amount');
        await supa.from('settings').upsert({
            guild_id: gid,
            message_points: amt
        });
        return inter.reply(`✅ XP per message set to **${amt}**.`);
    }

    if (inter.commandName === 'allowchannel') {
        if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Admin only.');
        const channel = inter.options.getChannel('channel');
        if (!channel.isTextBased()) return inter.reply('❌ Please select a text-based channel.');
        await supa.from('allowed_channels').upsert({
            guild_id: gid,
            channel_id: channel.id
        });
        return inter.reply(`✅ XP now allowed in <#${channel.id}>`);
    }

    if (inter.commandName === 'removechannel') {
        if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Admin only.');
        const channel = inter.options.getChannel('channel');
        await supa.from('allowed_channels').delete().eq('guild_id', gid).eq('channel_id', channel.id);
        return inter.reply(`🚫 XP disabled in <#${channel.id}>`);
    }

    if (inter.commandName === 'setlevelupchannel') {
        if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return inter.reply('❌ Admin only.');
        }

        const channel = inter.options.getChannel('channel');
        if (!channel.isTextBased()) {
            return inter.reply('❌ Please select a text-based channel.');
        }

        await supa.from('settings').upsert({
            guild_id: gid,
            levelup_channel: channel.id
        });
        return inter.reply(`📢 Level-up messages will now be sent in <#${channel.id}>.`);
    }

    if (inter.commandName === 'setrole') {
        if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) return inter.reply('❌ Admin only.');
        const min = inter.options.getInteger('min');
        const max = inter.options.getInteger('max');
        const role = inter.options.getRole('role');

        const {
            data: existing
        } = await supa.from('level_roles').select().eq('guild_id', gid);
        const overlapping = existing?.some(r =>
            (min >= r.min_level && min <= r.max_level) ||
            (max >= r.min_level && max <= r.max_level)
        );
        if (overlapping) return inter.reply('❌ Overlapping level range exists.');

        await supa.from('level_roles').insert({
            guild_id: gid,
            min_level: min,
            max_level: max,
            role_id: role.id
        });
        return inter.reply(`🎖️ Role **${role.name}** will now be assigned to levels ${min}–${max}`);
    }

    if (inter.commandName === 'removerole') {
        if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return inter.reply('❌ Admin only.');
        }

        const role = inter.options.getRole('role');
        const {
            data: existing
        } = await supa.from('level_roles').select().eq('guild_id', gid).eq('role_id', role.id).single();

        if (!existing) {
            return inter.reply('❌ That role is not aassigned through level roles.');
        }

        await supa.from('level_roles').delete().eq('guild_id', gid).eq('role_id', role.id);
        return inter.reply(`🗑️ Removed **${role.name}** from level role assignments.`);
    }

    if (inter.commandName === 'setminimumpervc') {
	  const min = inter.options.getInteger('min');
	  const role = inter.options.getRole('role');
	  const guildId = inter.guild.id;
	
	  const { error } = await supa
	    .from('settings')
	    .upsert({
	      guild_id: guildId,
	      vc_personqty: min,
	      vc_role_id: role.id,
	      updated_at: new Date().toISOString()
	    }, { onConflict: 'guild_id' });
	
	  if (error) {
	    console.error('❌ Supabase error:', error.message);
	    return inter.reply({
	      content: '❌ Failed to save VC settings. Please try again later.',
	      ephemeral: true
	    });
	  }
	
	  await inter.reply({
	    content: `✅ VC requirement settings updated:\n• Minimum members: **${min}**\n• Role to assign: **${role.name}**`,
	    ephemeral: true
	  });
    }

    if (inter.commandName === 'leaderboard') {
        const {
            data: top
        } = await supa.from('users').select().order('xp', {
            ascending: false
        }).limit(10);
        const members = await inter.guild.members.fetch();
        const list = top.map((u, i) => `**${i + 1}.** ${members.get(u.user_id)?.displayName || `<@${u.user_id}>`} – ${u.xp} XP`).join('\n');

        return inter.reply({
            embeds: [{
                title: '🏆 Top 10 Leaderboard',
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
    if (!allowed?.some(c => String(c.channel_id) === String(cid))) return;

    const { data: setting } = await supa.from('settings').select().eq('guild_id', gid).single();
    if (!setting) return;

    const baseXp = setting?.message_points ?? parseInt(process.env.DEFAULT_MESSAGE_POINTS) ?? settingsConfig.default_message_points;
    const boostMultiplier = setting?.booster_multiplier ?? 1;
    const boostRoleId = setting?.vc_role_id;

    const member = await msg.guild.members.fetch(uid);
    const hasBoostRole = boostRoleId && member.roles.cache.has(boostRoleId);
    const xpGain = hasBoostRole ? baseXp * boostMultiplier : baseXp;

    let { data: user } = await supa.from('users').select().eq('user_id', uid).single();
    if (!user) {
        const res = await supa.from('users').insert({
            user_id: uid,
            xp: 0,
            lvl: 1,
            coins: 0,
            streak: 1,
            last_active: now
        }).select().single();
        user = res.data;
    }

    const newXp = user.xp + xpGain;
    const newLvl = Math.floor(Math.sqrt(newXp / 10)) + 1;
    const leveledUp = newLvl > user.lvl;

    await supa.from('users').update({
        xp: newXp,
        lvl: newLvl,
        last_active: now
    }).eq('user_id', uid);

    if (leveledUp) {
        const { data: roles } = await supa.from('level_roles').select().eq('guild_id', gid);
        const announceChannelId = setting?.levelup_channel;
        const announceChannel = announceChannelId ? msg.guild.channels.cache.get(announceChannelId) : msg.channel;

        announceChannel?.isTextBased() && announceChannel.send(`🎉 <@${uid}> leveled up to **${newLvl}**!`);

        const matchedRoles = roles?.filter(r => newLvl >= r.min_level && newLvl <= r.max_level) || [];
        for (const r of matchedRoles) {
            const role = msg.guild.roles.cache.get(r.role_id);
            if (role && !member.roles.cache.has(role.id)) {
                await member.roles.add(role);
                msg.channel.send(`🛡️ <@${uid}> received role **${role.name}**!`);
            }
        }
    }

    const { data: existing } = await supa
        .from('message_log')
        .select('_count')
        .eq('user_id', uid)
        .eq('guild_id', gid)
        .eq('date', now)
        .single();

    if (existing) {
        await supa.from('message_log')
            .update({ _count: existing._count + 1 })
            .eq('user_id', uid)
            .eq('guild_id', gid)
            .eq('date', now);
    } else {
        await supa.from('message_log')
            .insert({ user_id: uid, guild_id: gid, date: now, _count: 1 });
    }
});



bot.on('voiceStateUpdate', async (oldState, newState) => {
  const uid = newState.id;
  const guild = newState.guild;
  const guild_id = guild.id;
  const member = await guild.members.fetch(uid).catch(() => null);
  if (!member) return;

  const inVoice = newState.channelId !== null;
  const selfMuted = newState.selfMute;
  const selfDeafened = newState.selfDeaf;
  const eligible = inVoice && !selfMuted && !selfDeafened;

  if (eligible) {
    activeVoiceUsers.set(uid, { guild_id, channel_id: newState.channelId });
  } else {
    activeVoiceUsers.delete(uid);
  }

  const affectedChannelId = newState.channelId || oldState.channelId;
  if (!affectedChannelId) return;

  const lastUpdated = roleCooldown.get(affectedChannelId) || 0;
  const now = Date.now();
  if (now - lastUpdated < COOLDOWN_MS) return;
  roleCooldown.set(affectedChannelId, now);

  const { data: setting, error } = await supa
    .from('settings')
    .select('vc_personqty, vc_role_id')
    .eq('guild_id', guild_id)
    .single();

  if (error || !setting) return;

  const { vc_personqty, vc_role_id } = setting;
  const role = await guild.roles.fetch(vc_role_id).catch(() => null);
  if (!role) return;

  const voiceChannel = guild.channels.cache.get(affectedChannelId);
  if (!voiceChannel || voiceChannel.type !== 2) return;

  const humanMembers = voiceChannel.members.filter(m => !m.user.bot);
  const minimum = vc_personqty ?? 2;
  const meetsMinimum = humanMembers.size >= minimum;

  for (const [, m] of humanMembers) {
    const hasRole = m.roles.cache.has(role.id);
    if (meetsMinimum && !hasRole) {
      await m.roles.add(role).catch(() => {});
    } else if (!meetsMinimum && hasRole) {
      await m.roles.remove(role).catch(() => {});
    }
  }

  // 🔧 If user left VC entirely, remove role if they had it
  if (!inVoice && role && member.roles.cache.has(role.id)) {
    await member.roles.remove(role).catch(() => {});
  }
});







// XP Decay Job
cron.schedule('0 4 * * *', async () => {
    const today = new Date();
    const {
        data: configs
    } = await supa.from('decay_config').select();
    const {
        data: users
    } = await supa.from('users').select();

    for (const g of configs) {
        const cutoff = new Date(today - g.days_before_decay * 86400e3).toISOString().split('T')[0];
        for (const u of users) {
            if (u.last_active < cutoff) {
                const newXp = Math.floor(u.xp * (1 - g.percentage_decay));
                const newLvl = Math.floor(Math.sqrt(newXp / 10)) + 1;
                await supa.from('users').update({
                    xp: newXp,
                    lvl: newLvl
                }).eq('user_id', u.user_id);
            }
        }
    }
});

// Streak Update Job – 5:00 AM
cron.schedule('0 5 * * *', async () => {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const yesterday = new Date(today.getTime() - 86400e3).toISOString().split('T')[0];

    const {
        data: configs
    } = await supa.from('streak_config').select();
    if (!configs) return;

    for (const config of configs) {
        const {
            guild_id,
            required_message
        } = config;

        const {
            data: users
        } = await supa.from('users').select();
        if (!users) continue;

        for (const user of users) {
            // Get yesterday's message count
            const {
                data: msgLog
            } = await supa.from('message_log')
                .select('_count')
                .eq('guild_id', guild_id)
                .eq('user_id', user.user_id)
                .eq('date', yesterday)
                .single();

            const messagesYesterday = msgLog?._count ?? 0;
            let newStreak;
		
            // if (user.last_active === todayStr) {
            //     newStreak = user.streak; // Already active today
            // } else
	    //Code Update : fucku  eto lang pala kaw, mag uupdate ka na bukas    
	    if (messagesYesterday >= required_message) { //must meet the required message per day
                newStreak = user.streak + 1;
            } else {
                newStreak = 1; //else will retrieve back to 1
            }

            await supa.from('users')
                .update({
                    streak: newStreak
                })
                .eq('user_id', user.user_id);
        }
    }

    console.log('✅ Streaks updated at 5:00 AM based on message count');
});

cron.schedule('* * * * *', async () => {
  const now = new Date().toISOString().split('T')[0];

  // Group active VC users by guild
  const guildGroups = {};
  for (const [uid, { guild_id }] of activeVoiceUsers.entries()) {
    if (!guildGroups[guild_id]) guildGroups[guild_id] = [];
    guildGroups[guild_id].push(uid);
  }

  for (const [guild_id, userIds] of Object.entries(guildGroups)) {
    const guild = bot.guilds.cache.get(guild_id);
    if (!guild) continue;

    // Fetch guild settings once
    const { data: setting } = await supa
      .from('settings')
      .select()
      .eq('guild_id', guild_id)
      .single();
    if (!setting) continue;

    const baseXp = setting?.vc_points ?? Number(process.env.DEFAULT_VC_POINTS) ?? 2;
    const boostMultiplier = setting?.booster_multiplier ?? 1;
    const boostRoleId = setting?.vc_role_id;

    // Fetch all members in one call
    const members = await guild.members.fetch({ user: userIds });

    // Prepare updates in bulk
    const updates = [];

    // Fetch existing users in one query
    const { data: existingUsers } = await supa
      .from('users')
      .select()
      .eq('guild_id', guild_id)
      .in('user_id', userIds);

    const existingMap = new Map(existingUsers?.map(u => [u.user_id, u]) || []);

    for (const uid of userIds) {
      const member = members.get(uid);
      if (!member) continue;

      const hasBoostRole = boostRoleId && member.roles.cache.has(boostRoleId);
      const xpGain = hasBoostRole ? baseXp * boostMultiplier : baseXp;

      let user = existingMap.get(uid);
      if (!user) {
        user = {
          guild_id,
          user_id: uid,
          xp: 0,
          lvl: 1,
          coins: 0,
          streak: 1,
          last_active: now
        };
      }

      const newXp = user.xp + xpGain;
      const newLvl = Math.floor(Math.sqrt(newXp / 10)) + 1;
      const leveledUp = newLvl > user.lvl;

      updates.push({
        guild_id,
        user_id: uid,
        xp: newXp,
        lvl: newLvl,
        last_active: now
      });

      if (leveledUp) {
        const { data: roles } = await supa
          .from('level_roles')
          .select()
          .eq('guild_id', guild_id);
        const announceChannelId = setting?.levelup_channel;
        const announceChannel = announceChannelId ? guild.channels.cache.get(announceChannelId) : null;

        if (announceChannel?.isTextBased()) {
          announceChannel.send(`🔊 <@${uid}> leveled up to **${newLvl}** from voice chat!`);
        }

        const matchedRoles = roles?.filter(r => newLvl >= r.min_level && newLvl <= r.max_level) || [];
        for (const r of matchedRoles) {
          const role = guild.roles.cache.get(r.role_id);
          if (role && !member.roles.cache.has(role.id)) {
            await member.roles.add(role).catch(() => {});
            announceChannel?.send(`🛡️ <@${uid}> received role **${role.name}**!`);
          }
        }
      }
    }

    // Bulk upsert all XP changes for this guild
    if (updates.length > 0) {
      await supa.from('users').upsert(updates, { onConflict: 'guild_id,user_id' });
    }
  }
});


cron.schedule('*/5 * * * *', async () => {
  console.log('🏆 Refreshing Top 10 GA roles...');

  const { data: guildSettings, error } = await supa
    .from('settings')
    .select('guild_id, Top10GARoleID');

  if (error || !guildSettings) {
    console.error('❌ Failed to fetch settings:', error);
    return;
  }

  for (const { guild_id, Top10GARoleID } of guildSettings) {
    if (!Top10GARoleID) {
      console.warn(`⚠️ No Top10GARoleID set for guild ${guild_id}`);
      continue;
    }

    const guild = bot.guilds.cache.get(guild_id);
    if (!guild) {
      console.warn(`⚠️ Bot not in guild ${guild_id}`);
      continue;
    }

    let role;
    try {
      role = await guild.roles.fetch(Top10GARoleID);
    } catch {
      console.warn(`⚠️ Role ${Top10GARoleID} not found in guild ${guild_id}`);
      continue;
    }
    if (!role) {
      console.warn(`⚠️ Role ${Top10GARoleID} is null in guild ${guild_id}`);
      continue;
    }

    // Remove role from all current holders
    for (const [, member] of role.members) {
      try {
        await member.roles.remove(role);
        console.log(`⬅️ Removed role from ${member.user.tag}`);
        await new Promise(res => setTimeout(res, 500));
      } catch (err) {
        console.error(`❌ Failed to remove role from ${member.user.username}:`, err.message);
      }
    }

    // Fetch top 10 XP users across all guilds (no guild_id filtering)
    const { data: topUsers, error: topErr } = await supa
      .from('users')
      .select('user_id')
      .order('xp', { ascending: false })
      .limit(10);

    if (topErr) {
      console.error(`❌ Error fetching top users:`, topErr.message);
      continue;
    }

    if (!topUsers || topUsers.length === 0) {
      console.warn(`⚠️ No top users found.`);
      continue;
    }

    console.log(`🏅 Top 10 users:`, topUsers.map(u => u.user_id));

    // Assign role to top 10
    for (const { user_id } of topUsers) {
      try {
        const member = await guild.members.fetch(user_id).catch(() => null);
        if (member && !member.roles.cache.has(role.id)) {
          await member.roles.add(role);
          console.log(`➡️ Added role to ${member.user.tag}`);
          await new Promise(res => setTimeout(res, 500));
        }
      } catch (err) {
        console.error(`❌ Failed to add role to ${user_id}:`, err.message);
      }
    }
  }

  console.log('✅ Top 10 GA roles refreshed.');
});


bot.login(process.env.DISCORD_TOKEN);
