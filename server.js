{
  "name": "ademicon-whatsapp",
  "version": "2.0.0",
  "scripts": {
    "start": "node server.js",
    "postinstall": "npx puppeteer browsers install chrome"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "socket.io": "^4.7.4",
    "qrcode": "^1.5.3",
    "whatsapp-web.js": "^1.23.0",
    "puppeteer": "^21.11.0"
  }
}
