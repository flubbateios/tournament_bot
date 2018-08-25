const {remote} = require('electron');
const {dialog} = remote;

const $ = require('jquery');
const ko = require('knockout');
ko.mapping = require('knockout-mapping');
const Popper = require('popper.js');
require('bootstrap');

const fs = require('fs');
const request = require('request-promise-native');
const io = require('socket.io-client');
const _ = require('lodash');
const path = require('path');

const UBERNET_USER_TO_UBERID = 'https://4.uberent.com/GameClient/UserId';
const UBERNET_AUTH = 'https://4.uberent.com/GC/Authenticate';
ko.bindingHandlers.tooltip = {
	init: (element, valueAccessor) => {
		const local = ko.utils.unwrapObservable(valueAccessor());
		const defaultOptions = {
			placement: 'top',
			trigger: 'hover'
		};
		const options = Object.assign(defaultOptions, local);
		$(element).tooltip(options);
		ko.utils.domNodeDisposal.addDisposeCallback(element, () => {
			$(element).tooltip('dispose');
		});
	}
};
String.prototype.replaceAll = function(search, replacement){
	const target = this;
	const str = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return target.replace(new RegExp(str, 'g'), replacement);
};
process.setMaxListeners(1000);
class ViewModel {
	constructor() {
		this.tLog = ko.observableArray();
		this.phrases = {};
		this.language = ko.observable('English');
		this.language.subscribe(() => {
			this.updatePhrases();
		});
		this.updatePhrases();
		this.selectedTab = ko.observable('info');
		this.selectedTab.subscribe(r=>{
			switch(r){
				case 'tournament-select':
					this.getTournaments();
					this.getDiscordChannels();
					break;
			}
		})
		this.workingDirectory = ko.observable('./');
		this.challonge = {
			key: ko.observable(''),
			tested: ko.observable(false)
		};
		this.superStats = {
			key: ko.observable(''),
			pass: ko.observable(''),
			username: ko.observable(''),
			tournamentIdentifier: ko.observable(''),
			reportSockConnected: ko.observable(false),
			loggedIn:ko.observable(false)
		};
		this.superStatsReporter = io('https://flubbateios.com', {
			path: '/stats/api/ws',
			autoConnect: false,
			forceNode: true
		});
		this.superStatsReporter.on('connect', () => {
			this.superStats.reportSockConnected(true);
			this.superStatsReporter.emit('identify', {type:'webservice'});
		});
		this.superStatsReporter.on('reconnect', () => {
			this.superStats.reportSockConnected(true);
			this.superStatsReporter.emit('identify',{type:'webservice'});
		});
		this.superStatsReporter.on('disconnect', () =>this.superStats.reportSockConnected(false));
		this.superStatsReporter.on('gameStart',r=>{
			this.handleSuperStatsGame(r,'gameStart');
		});
		this.superStatsReporter.on('gameOver',r=>{
			this.handleSuperStatsGame(r,'gameOver');
		});
		this.reportingMatches = ko.observable(false);
		this.reportingMatches.subscribe(r=>{
			if(r){
				if(!this.superStats.reportSockConnected()){
					this.superStatsReporter.open();
				}
			}else{
				this.superStatsReporter.disconnect();
			}
		});
		this.superStats.addingGamesToTournament = ko.computed(() => this.superStats.key().length && this.superStats.tournamentIdentifier().length);
		this.uberNet = {
			username: ko.observable(''),
			password: ko.observable(''),
			tested: ko.observable(false)
		};
		this.tournaments = {
			availableTournaments: ko.observable([]),
			selectedId: ko.observable('')
		};
		this.tournaments.viewTournaments = ko.computed(() =>
			this.tournaments.availableTournaments().map(r => {
				return {
					name: ko.observable(r.name),
					id: ko.observable(r.id)
				};
			})
		);
		this.tournaments.selectedId.subscribe(r => {
			r.length && this.updateCurrentTournament();
		});
		this.currentTournament = ko.observable();
		this.tournamentStarted = ko.observable(false);
		this.currentTournament.subscribe(r=>{
			if(!r){
				return;
			}
			this.tournamentStarted(r.state === 'underway');
		});
		this.teams = ko.observableArray();
		this.teamSize = ko.observable(1);
		this.teamsNumber = ko.computed(() => {
			return this.teams().length;
		});
		this.playersNumber = ko.computed(() => {
			let k = 0;
			for(let x of this.teams()){
				for(let y of x.players()){
					k += (y.uberId() && y.discordId()) ? 1 : 0;
				}
			}
			return k;
		});
		this.expectedPlayers = ko.computed(() => {
			return this.teams().length * this.teamSize();
		});
		this.teamsEditMode = ko.observable(false);
		((k)=>{
			const window = false;
			k.discordClient = new (require('discord.js').Client)();
		})(this);
		this.discordOptions = {
			mentionUsers: ko.observable(true),
			token: ko.observable(''),
			announceChannel: false,
			announceChannelName:ko.observable('None'),
			clientConnected: ko.observable(false),
			channels:ko.observableArray()
		};
		this.discordClient.on('ready', () =>{
			this.log('Connected to Discord');
			this.discordOptions.clientConnected(true);
		});
		this.discordClient.on('resume', () =>{
			this.log('Connected to Discord');
			this.discordOptions.clientConnected(true);
		});
		this.discordClient.on('disconnect', () =>{
			this.log('Disconnected from Discord');
			this.discordOptions.clientConnected(false);
		});
		this.discordClient.on('error', () =>{
			this.log('Disconnected from Discord');
			this.discordOptions.clientConnected(false);
		});
		this.checkin = {
			checkingIn: ko.observable(false),
			checkingUsers: ko.observableArray()
		};
		this.matches = {
			reportedMatches: [],
			announceableMatches: ko.observableArray(),
			handledStarts:[]
		};
		this.matches.processedMatches = ko.computed(() => {
			if(!this.currentTournament()){
				return;
			}
			return _.filter(
				this.currentTournament().matches.map(r => {
					const n = _.cloneDeep(r.match);
					if (!(n.player1_id && n.player2_id)) {
						return false;
					}
					n.match_number = n.suggested_play_order;
					n.player1_name = this.getTeamById(n.player1_id).name;
					n.player2_name = this.getTeamById(n.player2_id).name;
					n.player1_name_esc = n.player1_name.replace(/(_|\*|\~)/g,'\\$1');
					n.player2_name_esc = n.player2_name.replace(/(_|\*|\~)/g,'\\$1');
					const p1 = this.getLocalTeamByName(n.player1_name);
					const p2 = this.getLocalTeamByName(n.player2_name);
					if(!(p1 && p2)){
						return false;
					}
					n.player1_uber_ids = p1.players.map(q => q.uberId);
					n.player2_uber_ids = p2.players.map(q => q.uberId);
					n.participating_uber_ids = _.concat(n.player1_uber_ids,n.player2_uber_ids);
					n.player1_discord_ids = p1.players.map(q => q.discordId);
					n.player2_discord_ids = p2.players.map(q => q.discordId);
					n.player1_display_names = p1.players.map(q => q.displayName);
					n.player1_display_names_esc = n.player1_display_names.map(q => q.replace(/(_|\*|\~)/g,'\\$1'));
					n.player2_display_names = p2.players.map(q => q.displayName);
					n.player2_display_names_esc = n.player2_display_names.map(q => q.replace(/(_|\*|\~)/g,'\\$1'));
					return n;
				}),q => q);
		});
		this.matches.openMatches = ko.computed(() => {
			if(!this.currentTournament()){
				return;
			}
			return _.filter(this.matches.processedMatches(), r => r.state === 'open');
		});
		this.matches.openMatches.subscribe(async r => {
			if(!this.currentTournament()){
				return;
			}
			//remove old matches
			const n = [];
			for (let x of this.matches.announceableMatches()) {
				let found = false;
				for (let y of r) {
					if (x.id === y.id) {
						found = true;
						break;
					}
				}
				if (found) {
					n.push(x);
				}
			}
			for (let x of r) {
				let found = false;
				for (let y of this.matches.announceableMatches()) {
					if (x.id === y.id) {
						found = true;
						break;
					}
				}
				if (!found) {
					n.push(
						Object.assign(x, {
							announce: ko.observable(true),
							cast: ko.observable(false),
							caster: ko.observable(''),
							teams: ko.observable(`${x.player1_name} vs. ${x.player2_name}`),
							players: ko.observable(`${x.player1_display_names.join(', ')} vs. ${x.player2_display_names.join(', ')}`)
						})
					);
				}
			}
			this.matches.announceableMatches(n);
		});
		this.canSeeTDSelect = ko.computed(()=>{
			return this.uberNet.tested() && (!this.superStats.addingGamesToTournament() || this.superStats.key()) && this.discordOptions.clientConnected() && this.challonge.tested()
		});
		this.canSeePlayerSelect = ko.computed(() => {
			return this.canSeeTDSelect() && (this.discordOptions.announceChannelName() !== 'None') && this.currentTournament();
		});
		this.canSeeCheckIn = ko.computed(()=>{
			let found = 0;
			let checked = 0;
			for(let x of this.teams()){
				for(let y of x.players()){
					checked++;
					if(y.uberId().length && y.discordId().length){
						found++
					}
				}
			}
			return this.canSeePlayerSelect() && (found === checked);
		});
		this.additiveTeamProcessing = ko.observable(false);
		this.lockedTeams = ko.observable(false);
		this.updateTimeout = setInterval(() => {
			this.tournaments.selectedId() && this.updateCurrentTournament();
		}, 10 * 1000);
	}
	log(r) {
		const s = `${new Date().toUTCString()} : ${r}`;
		this.tLog.push(s);
		console.log(s);
	}
	updatePhrases() {
		this.log('Updating phrases.');
		let data;
		try {
			data = fs.readFileSync(`./data/${this.language()}.loc`, 'utf8');
		} catch (e) {
			this.language('English');
			return false;
		}
		//Developed on a windows machine but Git converts to LF.
		const lineEnding = data.includes('\r\n') ? '\r\n' : '\n';
		data = data.split(lineEnding);
		const n = {};
		for (let x of data) {
			const y = x.split(': ');
			const key = y.shift();
			const val = y.join(': ');
			n[key] = val;
		}
		this.phrases = n;
	}
	loginToDiscord() {
		return new Promise((res, rej) => {
			this.discordClient.login(this.discordOptions.token());
			this.discordClient.on('ready', () => {
				res();
			});
			this.discordClient.on('error', () => {
				rej();
			});
		});
	}
	destroyDiscordClient(){
		this.discordClient.destroy();
	}
	async loginToSuperStats() {
		this.log('Logging in to Super Stats');
		const a = await request({
			method: 'POST',
			url: 'https://flubbateios.com/stats/api/users/getkey',
			body: {
				username: this.superStats.username(),
				password: this.superStats.pass()
			},
			json: true
		});
		if (a.error) {
			this.log(`Failed to login to super stats ${a.error}`);
			return false;
		} else {
			this.superStats.key(a.apiKey);
			this.superStats.loggedIn(true);
			return a.apiKey;
		}
	}
	async testLoginToUbernet() {
		this.log('Testing uberNet login');
		const e = await request({
			url: UBERNET_AUTH,
			method: 'POST',
			body: {
				TitleId: 4,
				AuthMethod: 'UberCredentials',
				UberName: this.uberNet.username(),
				Password: this.uberNet.password()
			},
			json: true
		});
		if (typeof e === 'object') {
			this.uberNet.tested(true);
			return true;
		}
	}
	async testChallonge() {
		this.log('Testing Challonge key.');
		let e;
		try{
			e = await request({
				url: `https://api.challonge.com/v1/tournaments.json?api_key=${this.challonge.key()}`,
				method: 'GET',
				json: true
			});
		}catch(q){
			this.log('Incorrect Challonge API key or internet connection is down.');
			return false;
		}
		this.challonge.tested(true);
		return true;
	}
	getDiscordChannels(){
		const d = [...this.discordClient.channels.values()];
		const e = _.filter(d,r => r.type === 'text').map(r=>{
			return {
				name:r.name,
				id:r.id,
				guild:r.guild.name
			};
		});
		this.discordOptions.channels(e);
	}
	async getTournaments() {
		let a = await request({
			method: 'GET',
			url: 'https://api.challonge.com/v1/tournaments.json',
			qs: {
				api_key: this.challonge.key(),
				state: 'all'
			}
		});
		a = JSON.parse(a);
		a = a.map(r => r.tournament);
		this.tournaments.availableTournaments(a);
		this.log('Got list of tournaments');
	}
	async updateCurrentTournament() {
		let a = await request({
			method: 'GET',
			url: `https://api.challonge.com/v1/tournaments/${this.tournaments.selectedId()}.json`,
			qs: {
				api_key: this.challonge.key(),
				include_participants: 1,
				include_matches: 1
			}
		});
		a = JSON.parse(a).tournament;
		this.currentTournament(a);
		this.log('Updated current tournament.');
	}
	async processUsernames() {
		this.log('Processing Uber and Discord usernames.');
		this.lockedTeams(true);
		const e = await request({
			url: UBERNET_AUTH,
			method: 'POST',
			body: {
				TitleId: 4,
				AuthMethod: 'UberCredentials',
				UberName: this.uberNet.username(),
				Password: this.uberNet.password()
			},
			json: true
		});
		const sessionTicket = e.SessionTicket;
		await this.discordOptions.announceChannel.guild.fetchMembers();
		for (let team of this.teams()) {
			for (let y of team.players()) {
				//Gets rid of space between user and discriminator i.e. User #1234 instead of User#1234. Username cannot contain # so we're good.
				let dUsername = y.discordUsername();
				dUsername = dUsername.replace(/ (?=#[0-9]{4})/, '');
				y.discordUsername(dUsername);
				if(!y.uberId()){
					try{
						let uResp = await request({
							url: UBERNET_USER_TO_UBERID,
							method: 'GET',
							headers: {
								'X-Authorization': sessionTicket
							},
							form: {
								TitleDisplayName: y.displayName()
							}
						});
						uResp = JSON.parse(uResp);
						if (!uResp.ErrorCode) {
							y.uberId(uResp.UberId);
						}
					}catch(Err){}
				}
				const discordId = this.discordOptions.announceChannel.guild.members.find(r => r.user.tag.toLowerCase() === y.discordUsername().toLowerCase());
				if (discordId) {
					y.discordId(discordId.id);
				}
			}
		}
		this.log('Done processing usernames. Some may not have completed successfully.');
		this.lockedTeams(false);
		return true;
	}
	backupTeams() {
		fs.writeFileSync(
			path.join(this.workingDirectory(), this.tournaments.selectedId()),
			JSON.stringify(ko.mapping.toJS(this.teams()))
		);
	}
	loadTeamsFromBackup(loc) {
		let d = fs.readFileSync(loc, 'utf8');
		d = JSON.parse(d);
		this.teams(ko.mapping.fromJS(d)());
		this.log('Loaded teams from backup.');
	}
	processCSVTeams(csv, add) {
		this.log('Processing CSV.');
		const lineEnding = csv.includes('\r\n') ? '\r\n' : '\n';
		let q = csv.split(lineEnding);
		q = q.map(r => JSON.parse(`[${r}]`));
		const start = q.shift().map(r => r.toLowerCase());
		let discordUsernameIndex;
		let displayNameIndex;
		let teamNameIndex;
		for (let x in start) {
			if (start[x].includes('discord')) {
				discordUsernameIndex = x;
			} else if (
				start[x].includes('display name') ||
				start[x].includes('in-game') ||
				start[x].includes('in game')
			) {
				displayNameIndex = x;
			} else if (start[x].includes('team')) {
				teamNameIndex = x;
			}
		}
		if (!(displayNameIndex && discordUsernameIndex)) {
			return false;
		}
		const teams = {};
		this.log(`Found ${q.length} players`);
		let teamIdCounter = add ? Object.keys(this.teams()).length + 1 : 1;
		for (let x of q) {
			const teamName = teamNameIndex ? x[teamNameIndex] : x[displayNameIndex];
			const displayName = x[displayNameIndex];
			const discordUsername = x[discordUsernameIndex];
			if (!teams[teamName]) {
				teams[teamName] = {
					teamName: teamName,
					players: [],
					id: teamIdCounter
				};
				teamIdCounter++;
			}
			teams[teamName].players.push({
				displayName: displayName,
				discordUsername: discordUsername,
				discordId: '',
				uberId: '',
				checkedIn: false
			});
		}
		this.log('Processed CSV.');
		this.teams(ko.mapping.fromJS(Object.values(teams))());
		return this.processUsernames();
	}
	async clearChallongePlayers() {
		await request({
			url: `https://api.challonge.com/v1/tournaments/${this.tournaments.selectedId()}/participants/clear.json`,
			method: 'DELETE',
			qs: {
				api_key: this.challonge.key()
			}
		});
		this.log('Cleared participants from Challonge.');
		return true;
	}
	async uploadTeamsToChallonge() {
		const body = {
			api_key: this.challonge.key()
		};
		body.participants = ko.mapping.toJS(this.teams()).map(r => {
			return {
				name: r.teamName,
				misc: r.id
			};
		});
		await request({
			url: `https://api.challonge.com/v1/tournaments/${this.tournaments.selectedId()}/participants/bulk_add.json`,
			method: 'POST',
			json: true,
			body: body
		});
		this.log('Added participants to Challonge.');
		return true;
	}
	async syncTeams() {
		this.log('Syncing teams with Challonge.');
		await this.clearChallongePlayers();
		await this.uploadTeamsToChallonge();
		await this.updateCurrentTournament();
		this.backupTeams();
		this.log('Synced teams with Challonge.');
		return true;
	}
	async startTournament() {
		//Please please please use this button instead of doing it on challonge in order to save a backup of all the players. That data is NOT stored on Challonge.
		this.checkInStop();
		this.backupTeams();
		await request({
			url: `https://api.challonge.com/v1/tournaments/${this.tournaments.selectedId()}/start.json`,
			method: 'POST',
			body:{
				api_key:this.challonge.key()
			},
			json:true

		});
		this.updateCurrentTournament();
		this.tournamentStarted(true);
	}
	startReporting(){
		this.reportingMatches(true);
	}
	stopReporting(){
		this.reportingMatches(false);
	}
	async sendDiscordMessage(phrasename, options) {
		if (!this.phrases[phrasename].length) {
			return;
		}
		options = options || {};
		let phrase = this.phrases[phrasename];
		for (let key of Object.keys(options)) {
			const value = options[key];
			phrase = phrase.replaceAll(key, value);
		}
		this.discordOptions.announceChannel.send(phrase);
	}
	findPlayerByDiscordId(discordId, t) {
		for (let x of this.teams()) {
			for (let y of x.players()) {
				if (y.discordId() === discordId) {
					return t ? y : ko.mapping.toJS(y);
				}
			}
		}
	}
	findPlayerByUberId(uberId,t) {
		for (let x of this.teams()) {
			for (let y of x.players()) {
				if (y.uberId() === uberId) {
					return t ? y : ko.mapping.toJS(y);
				}
			}
		}
	}
	doCheckInRound() {
		const handleCheckin = r => {
			if (!this.checkin.checkingIn()) {
				return;
			}
			const msg = r.first();
			const authorid = msg.author.id;
			const player = this.findPlayerByDiscordId(authorid, true);
			player.checkedIn(true);
			const e = this.checkin.checkingUsers();
			_.pull(e, authorid);
			this.checkin.checkingUsers(e);
			this.log(`Checked in player ${player.displayName()}`);
			this.sendDiscordMessage('Checked-In-Player', {
				'%player%': player.displayName().replace(/(_|\*|\~)/g,'\\$1')
			});
			this.backupTeams();
		};
		this.log('Doing checkin round.');
		//Get unchecked players
		const players = [];
		for (let x of this.teams()) {
			for (let y of x.players()) {
				if (!y.checkedIn()) {
					players.push(y.discordId());
				}
			}
		}
		const check = _.difference(players, this.checkin.checkingUsers());
		for (let x of check) {
			this.discordOptions.announceChannel
				.awaitMessages(r => r.author.id === x, {
					maxMatches: 1
				})
				.then(r => handleCheckin(r));
			this.checkin.checkingUsers.push(x);
		}
	}
	checkInStart() {
		this.checkin.checkingIn(true);
		this.sendDiscordMessage('Checkin-Start');
		this.lockedTeams(true);
		this.doCheckInRound();
	}
	sendCheckinMessage() {
		const send = this.checkin.checkingUsers().map(r => `<@${r}>`).join(', ');
		this.sendDiscordMessage('Checkin-Call', {
			'%players%': send
		});
	}
	checkInStop() {
		this.log('Closing Check-In');
		this.checkin.checkingIn(false);
	}
	getTeamById(id) {
		for (let x of this.currentTournament().participants) {
			if (x.participant.id === id) {
				return x.participant;
			}
		}
	}
	getLocalTeamByName(name, t) {
		for (let x of this.teams()) {
			if (x.teamName() === name) {
				return t ? x : ko.toJS(x);
			}
		}
	}
	async announceSelectedGames() {
		for (let x of this.matches.announceableMatches()) {
			if (x.announce()) {
				await this.sendDiscordMessage('Match-Announce', {
					'%number%': x.match_number,
					'%team1%': x.player1_discord_ids.map(r => `<@${r}>`).join(', '),
					'%team2%': x.player2_discord_ids.map(r => `<@${r}>`).join(', '),
					'%onmap%': ''
				});
			}
		}
		return true;
	}
	async announceCasts() {
		for (let x of this.matches.announceableMatches()) {
			if (x.cast()) {
				await this.sendDiscordMessage('Match-Cast', {
					'%number%': x.match_number,
					'%team1%': x.player1_discord_ids.map(r => `<@${r}>`).join(', '),
					'%team2%': x.player2_discord_ids.map(r => `<@${r}>`).join(', '),
					'%caster%': x.caster()
				});
			}
		}
		return true;
	}
	handleSuperStatsGame(gm, ev) {
		if(!this.reportingMatches()){
			return;
		}
		this.log('Handling game start');
		const game = ev === 'gameStart' ? gm : gm.game;
		const e = game.armies;
		if (e.length !== 2) {
			return false;
		}
		for (let x of e) {
			if (x.extendedPlayers.length !== this.teamSize()) {
				return false;
			}
		}
		for (let x of this.matches.openMatches()) {
			if (_.intersection(game.participatingIds, x.participating_uber_ids).length !==this.teamSize() * 2) {
				continue;
			}
			for (let y of game.armies) {
				const players = y.extendedPlayers.map(r => r.uberId);
				if (_.intersection(players, x.player1_uber_ids).length === this.teamSize()) {
					ev === 'gameStart' ? this.handleGameStart(x,game) : this.handleGameEnd(game,x,y.teamId);
					return true;
				}
			}
			return false;
		}
	}
	handleGameStart(game,s){
		if(!this.matches.handledStarts.includes(s.lobbyId)){
			this.matches.handledStarts.push(s.lobbyId);
			this.log(`Handling game ${game.match_number} start.`);
			this.sendDiscordMessage('Match-Started',{
				'%number%':game.match_number,
				'%teamname1%':game.player1_name_esc,
				'%teamname2%':game.player2_name_esc
			});
		}
	}
	async handleGameEnd(sGame,cGame,p1TeamId){
		this.log(`Handling game ${cGame.match_number} end.`);
		if(sGame.winner === false){
			this.log(`Game ${cGame.match_number} failed to report. You will have to report this game manually.`);
			return false;
		}
		if(this.superStats.addingGamesToTournament()){
			request({
				method:'POST',
				url:`https://flubbateios.com/stats/api/matches/${sGame.lobbyId}/tournament`,
				json:true,
				body:{
					apiKey:this.superStats.key(),
					identifier:this.superStats.tournamentIdentifier()
				}
			});
		}
		const winner = (p1TeamId === sGame.winner) ? 'player1' : 'player2';
		const winnerId = cGame[`${winner}_id`];
		const sCsv = winner === 'player1' ? '1-0' : '0-1';
		this.log('Reporting score to Challonge.');
		const rsp = await request({
			method:'PUT',
			url:`https://api.challonge.com/v1/tournaments/${this.tournaments.selectedId()}/matches/${cGame.id}.json`,
			json:true,
			body:{
				api_key:this.challonge.key(),
				match:{
					scores_csv:sCsv,
					winner_id:winnerId
				}
			}
		});
		const superStatsUrl = `https://flubbateios.com/stats/match.html?match=${sGame.lobbyId}`;
		try{
			await request({
				method:'POST',
				url:`https://api.challonge.com/v1/tournaments/${this.tournaments.selectedId()}/matches/${cGame.id}/attachments.json`,
				json:true,
				body:{
					api_key:this.challonge.key(),
					url:superStatsUrl,
					text:'Super Stats'
				}
			});
		}catch(err){
			this.log('failed to add attachment.');
		}
		await this.sendDiscordMessage('Match-Ended',{
			'%number%':cGame.match_number,
			'%teamname1%':cGame.player1_name_esc,
			'%teamname2%':cGame.player2_name_esc,
			'%winner%':cGame[`${winner}_display_names_esc`].join(', '),
			'%superStatsUrl%':superStatsUrl
		});
		return true;
	}
	//Ui stuff starts here
	autoFill(){
		dialog.showOpenDialog({
			title:'Select JSON',
			defaultPath:'./',
			properties:['openFile']
		},p => {
			if(!(p && p[0])){
				return;
			}
			const d = p[0];
			const k = JSON.parse(fs.readFileSync(d,'utf8'));
			this.uberNet.username(k.uberName);
			this.uberNet.password(k.uberPass);
			this.superStats.username(k.statsName);
			this.superStats.pass(k.statsPass);
			this.challonge.key(k.challonge);
			this.discordOptions.token(k.discord);
		});
	}
	selectWorkingDirectory(){
		dialog.showOpenDialog({
			title:'Select Working Directory',
			defaultPath:'./',
			properties:['openDirectory','promptToCreate']
		},p => {
			if(!(p && p[0])){
				return;
			}
			this.workingDirectory(p[0]);
		})
	}
	selectTournamentId(data){
		this.tournaments.selectedId(data.id.toString());
	}
	selectDiscordChannel(data){
		this.discordOptions.announceChannel = this.discordClient.channels.get(data.id);
		this.discordOptions.announceChannelName(data.name);
	}
	openLoadFromCSV(){
		dialog.showOpenDialog({
			title:'Select JSON',
			defaultPath:this.workingDirectory(),
			properties:['openFile']
		},p => {
			if(!(p && p[0])){
				return;
			}
			const d = p[0];
			const e = fs.readFileSync(d,'utf8');
			this.processCSVTeams(e,this.additiveTeamProcessing());
		});
	}
	removeTeam(team){
		this.teams.splice(this.teams().indexOf(team),1);
	}
	openSaveJSON(){
		this.log('Saving to JSON');
		dialog.showOpenDialog({
			title:'Select JSON',
			defaultPath:this.workingDirectory()
		},p => {
			if(!(p && p[0])){
				return;
			}
			const d = p[0];
			fs.writeFileSync(d,ko.mapping.toJS(this.teams));
		});
	}
	openLoadFromJSON(){
		this.log('Opening from JSON');
		dialog.showOpenDialog({
			title:'Select JSON',
			defaultPath:this.workingDirectory(),
			properties:['openFile']
		},p => {
			if(!(p && p[0])){
				return;
			}
			const d = p[0];
			const e = fs.readFileSync(d,'utf8');
			this.teams(ko.mapping.fromJS(JSON.parse(e))());
			this.teamSize(this.teams()[0].players().length);
			this.processUsernames();
		});
	}
}
const model = new ViewModel();
$(document).ready(() => {
	ko.applyBindings(model);
});
