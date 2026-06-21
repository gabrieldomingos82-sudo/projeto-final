const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

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
                '--disable-gpu',
                '--single-process',
                '--no-zygote'
            ]
        }
    });

    client.on('qr', async (qr) => {
        console.log('QR Code gerado! Escaneie com WhatsApp.');
        qrCodeData = await QRCode.toDataURL(qr);
        io.emit('whatsapp-status', { 
            connected: false, 
            qr: qrCodeData, 
            message: 'Escaneie o QR Code com seu WhatsApp' 
        });
    });

    client.on('ready', () => {
        console.log('✅ WhatsApp conectado!');
        isReady = true;
        qrCodeData = null;
        io.emit('whatsapp-status', { 
            connected: true, 
            qr: null,
            phone: client.info.wid.user,
            name: client.info.pushname,
            message: 'WhatsApp conectado! Pronto para enviar.' 
        });
    });

    client.on('disconnected', () => {
        console.log('WhatsApp desconectado');
        isReady = false;
        io.emit('whatsapp-status', { connected: false, qr: null, message: 'Desconectado' });
    });

    client.initialize().catch(err => {
        console.error('Erro ao iniciar:', err.message);
        io.emit('whatsapp-status', { connected: false, qr: null, message: 'Erro: ' + err.message });
    });
}

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
    console.log('🟢 Cliente conectado');
    
    // Enviar status atual
    socket.emit('whatsapp-status', {
        connected: isReady,
        qr: qrCodeData,
        phone: isReady && client ? client.info.wid.user : null,
        name: isReady && client ? client.info.pushname : null,
        message: isReady ? 'Conectado!' : 'Aguardando QR Code...'
    });
    
    // ENVIAR MENSAGEM (REALMENTE ENVIA!)
    socket.on('send-message', async (data) => {
        console.log('📤 Enviando para:', data.phone);
        
        if (!isReady || !client) {
            socket.emit('message-result', { success: false, error: 'WhatsApp não conectado!' });
            return;
        }
        
        try {
            const chatId = data.phone.includes('@c.us') ? data.phone : data.phone + '@c.us';
            await client.sendMessage(chatId, data.message);
            console.log('✅ Enviado para:', data.phone);
            socket.emit('message-result', { success: true, phone: data.phone });
        } catch (error) {
            console.error('❌ Erro:', error.message);
            socket.emit('message-result', { success: false, error: error.message });
        }
    });
    
    // ENVIAR EM LOTE
    socket.on('send-bulk', async (data) => {
        console.log('📤 Iniciando lote:', data.messages.length, 'mensagens');
        
        if (!isReady || !client) {
            socket.emit('bulk-done', { success: false, error: 'WhatsApp não conectado!' });
            return;
        }
        
        const { messages, delay } = data;
        let sent = 0;
        let failed = 0;
        
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            
            try {
                const chatId = msg.phone.includes('@c.us') ? msg.phone : msg.phone + '@c.us';
                await client.sendMessage(chatId, msg.message);
                sent++;
                
                socket.emit('bulk-progress', {
                    current: i + 1,
                    total: messages.length,
                    sent: sent,
                    failed: failed,
                    name: msg.name || msg.phone
                });
                
                console.log(`✅ [${i+1}/${messages.length}] ${msg.name || msg.phone}`);
            } catch (error) {
                failed++;
                console.error(`❌ [${i+1}/${messages.length}] ${msg.name || msg.phone}:`, error.message);
            }
            
            if (i < messages.length - 1) {
                await new Promise(r => setTimeout(r, (delay || 30) * 1000));
            }
        }
        
        socket.emit('bulk-done', {
            success: true,
            total: messages.length,
            sent: sent,
            failed: failed
        });
        
        console.log(`✅ Lote concluído! ${sent}/${messages.length} enviadas`);
    });
    
    // RECONECTAR
    socket.on('reconnect-whatsapp', () => {
        console.log('🔄 Reiniciando...');
        criarCliente();
    });
    
    // DESCONECTAR
    socket.on('disconnect-whatsapp', async () => {
        if (client) {
            try { await client.logout(); await client.destroy(); } catch(e) {}
        }
        isReady = false;
        client = null;
        qrCodeData = null;
        io.emit('whatsapp-status', { connected: false, qr: null, message: 'Desconectado' });
    });
});

// ==================== INICIAR ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('🚀 ADEMICON rodando na porta ' + PORT);
    criarCliente();
});
