const {app, BrowserWindow} = require('electron');
const url = require('url');
const path = require('path');
let win;
app.on('ready', () => {
	win = new BrowserWindow({
		width: 1024,
		height: 768
	});
	win.loadURL(url.format({
		pathname : path.join(__dirname,'index.html'),
		protocol:'file:',
		slashes:true
	}));
});
