const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ==================== WHATSAPP CLIENT ====================
let client = null;
let isReady = false;
let qrCodeData = null;

function criarCliente() {
    if (client) {
        try { client.destroy(); } catch(e) {}
    }
    
    client = new Client({
        authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ],
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
        }
    });

    client.on('qr', async (qr) => {
        console.log('QR Code gerado!');
        qrCodeData = await QRCode.toDataURL(qr);
        io.emit('whatsapp-status', { connected: false, qr: qrCodeData, message: 'Escaneie o QR Code' });
    });

    client.on('ready', () => {
        console.log('✅ WhatsApp conectado!');
        isReady = true;
        qrCodeData = null;
        io.emit('whatsapp-status', { connected: true, qr: null, phone: client.info.wid.user, name: client.info.pushname, message: 'Conectado!' });
    });

    client.on('disconnected', () => {
        console.log('WhatsApp desconectado');
        isReady = false;
        io.emit('whatsapp-status', { connected: false, qr: null, message: 'Desconectado' });
    });

    client.initialize().catch(err => {
        console.error('Erro ao iniciar:', err.message);
    });
}

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
    console.log('🟢 Cliente conectado');
    
    socket.emit('whatsapp-status', {
        connected: isReady,
        qr: qrCodeData,
        phone: isReady && client ? client.info.wid.user : null,
        name: isReady && client ? client.info.pushname : null,
        message: isReady ? 'Conectado!' : 'Aguardando QR Code...'
    });
    
    socket.on('send-message', async (data) => {
        if (!isReady || !client) {
            socket.emit('message-result', { success: false, error: 'WhatsApp não conectado!' });
            return;
        }
        try {
            const chatId = data.phone.includes('@c.us') ? data.phone : data.phone + '@c.us';
            await client.sendMessage(chatId, data.message);
            socket.emit('message-result', { success: true, phone: data.phone });
        } catch (error) {
            socket.emit('message-result', { success: false, error: error.message });
        }
    });
    
    socket.on('send-bulk', async (data) => {
        if (!isReady || !client) {
            socket.emit('bulk-done', { success: false, error: 'WhatsApp não conectado!' });
            return;
        }
        const { messages, delay } = data;
        let sent = 0, failed = 0;
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            try {
                const chatId = msg.phone.includes('@c.us') ? msg.phone : msg.phone + '@c.us';
                await client.sendMessage(chatId, msg.message);
                sent++;
                socket.emit('bulk-progress', { current: i + 1, total: messages.length, sent, failed, name: msg.name || msg.phone });
                console.log(`✅ [${i+1}/${messages.length}] ${msg.name || msg.phone}`);
            } catch (error) {
                failed++;
                console.error(`❌ ${msg.name || msg.phone}:`, error.message);
            }
            if (i < messages.length - 1) await new Promise(r => setTimeout(r, (delay || 30) * 1000));
        }
        socket.emit('bulk-done', { success: true, total: messages.length, sent, failed });
        console.log(`✅ Lote concluído! ${sent}/${messages.length}`);
    });
    
    socket.on('reconnect-whatsapp', () => { console.log('🔄 Reiniciando...'); criarCliente(); });
    
    socket.on('disconnect-whatsapp', async () => {
        if (client) { try { await client.logout(); await client.destroy(); } catch(e) {} }
        isReady = false; client = null; qrCodeData = null;
        io.emit('whatsapp-status', { connected: false, qr: null, message: 'Desconectado' });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('🚀 ADEMICON rodando na porta ' + PORT);
    criarCliente();
});
