const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== ESTADO GLOBAL DO WHATSAPP ====================
let waClient = null;
let waReady = false;
let waInfo = { phone: '', name: '' };
let lastQr = null;

// ==================== LOCALIZAR O EXECUTÁVEL DO CHROME ====================
// Em produção (Render), o Chrome é baixado pelo Puppeteer durante o
// "npm install" e fica salvo em ~/.cache/puppeteer. Esse cache às vezes não
// é encontrado automaticamente pelo whatsapp-web.js, então procuramos o
// binário manualmente nos locais mais comuns e apontamos o caminho exato -
// isso evita o erro "Could not find Chrome".
function getChromePath() {
    console.log('🔍 Deixando whatsapp-web.js usar o Chrome padrão...');
    return undefined; // Deixa o whatsapp-web.js cuidar disso
}

// ==================== CRIAÇÃO DO CLIENTE WHATSAPP ====================
// Usa LocalAuth para persistir a sessão em disco (./.wwebjs_auth). IMPORTANTE:
// no plano FREE do Render, o disco é completamente temporário - qualquer
// reinício do processo (sleep por inatividade, falta de memória, ou um novo
// deploy) apaga essa pasta e exige escanear o QR Code de novo. Isso é uma
// limitação do plano free do Render, não do código - só planos pagos com
// "Persistent Disk" mantêm a sessão entre reinícios.
function criarClienteWhatsApp() {
    waClient = new Client({
        authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
        puppeteer: {
            headless: true,
            executablePath: getChromePath(),
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-breakpad',
                '--disable-component-extensions-with-background-pages',
                '--disable-client-side-phishing-detection',
                '--disable-default-apps',
                '--disable-features=Translate,BackForwardCache,AcceptCHFrame,AvoidUnnecessaryBeforeUnloadCheckSync,IsolateOrigins,site-per-process',
                '--disable-hang-monitor',
                '--disable-ipc-flooding-protection',
                '--disable-popup-blocking',
                '--disable-prompt-on-repost',
                '--disable-renderer-backgrounding',
                '--disable-site-isolation-trials',
                '--disable-sync',
                '--disable-software-rasterizer',
                '--force-color-profile=srgb',
                '--metrics-recording-only',
                '--mute-audio',
                '--no-default-browser-check',
                '--password-store=basic',
                '--use-mock-keychain',
                '--renderer-process-limit=2',
                '--js-flags=--max-old-space-size=192'
            ]
        }
    });

    waClient.on('qr', async (qr) => {
        console.log('📱 Novo QR Code gerado');
        lastQr = await qrcode.toDataURL(qr);
        waReady = false;
        io.emit('whatsapp-status', { connected: false, qr: lastQr });
    });

    waClient.on('ready', () => {
        console.log('✅ WhatsApp conectado!');
        waReady = true;
        lastQr = null;
        const info = waClient.info;
        waInfo = {
            phone: info?.wid?.user || '',
            name: info?.pushname || ''
        };
        io.emit('whatsapp-status', {
            connected: true,
            phone: waInfo.phone,
            name: waInfo.name
        });
    });

    waClient.on('authenticated', () => {
        console.log('🔐 Sessão autenticada');
    });

    waClient.on('disconnected', (reason) => {
        console.log('❌ WhatsApp desconectado:', reason);
        waReady = false;
        waInfo = { phone: '', name: '' };
        io.emit('whatsapp-status', { connected: false });
    });

    waClient.on('auth_failure', (msg) => {
        console.error('❌ Falha na autenticação:', msg);
        waReady = false;
        io.emit('whatsapp-status', { connected: false });
    });

    waClient.initialize().catch(err => {
        console.error('❌ Erro ao inicializar WhatsApp:', err);
    });
}

criarClienteWhatsApp();

// ==================== HELPER: FORMATAR NÚMERO ====================
function formatarNumero(phone) {
    const digits = String(phone).replace(/\D/g, '');
    return digits.includes('@c.us') ? digits : `${digits}@c.us`;
}

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
    console.log('🔌 Cliente conectado ao painel:', socket.id);

    // Envia o status atual assim que o painel abre/recarrega
    socket.emit('whatsapp-status', waReady
        ? { connected: true, phone: waInfo.phone, name: waInfo.name }
        : { connected: false, qr: lastQr || undefined }
    );

    // ---- Reconectar / gerar novo QR Code ----
    socket.on('reconnect-whatsapp', async () => {
        try {
            if (waClient) {
                await waClient.destroy().catch(() => {});
            }
        } finally {
            waReady = false;
            lastQr = null;
            criarClienteWhatsApp();
        }
    });

    // ---- Desconectar ----
    socket.on('disconnect-whatsapp', async () => {
        try {
            if (waClient) {
                await waClient.logout().catch(() => {});
            }
        } finally {
            waReady = false;
            waInfo = { phone: '', name: '' };
            lastQr = null;
            io.emit('whatsapp-status', { connected: false });
        }
    });

    // ---- Disparo em massa ----
    socket.on('send-bulk', async ({ messages, delay }) => {
        if (!waReady || !waClient) {
            socket.emit('bulk-done', { sent: 0, error: 'WhatsApp não está conectado' });
            return;
        }

        const intervaloMs = Math.max(parseInt(delay) || 30, 10) * 1000;
        let enviados = 0;

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            try {
                const numero = formatarNumero(msg.phone);
                const isRegistered = await waClient.isRegisteredUser(numero);

                if (isRegistered) {
                    await waClient.sendMessage(numero, msg.message);
                    enviados++;
                } else {
                    console.warn(`⚠️ Número não encontrado no WhatsApp: ${msg.phone}`);
                }
            } catch (err) {
                console.error(`❌ Erro ao enviar para ${msg.phone}:`, err.message);
            }

            io.emit('bulk-progress', {
                current: i + 1,
                total: messages.length,
                name: msg.name,
                phone: msg.phone
            });

            // Aguarda o intervalo configurado antes do próximo envio
            // (evita bloqueio por excesso de mensagens em curto espaço de tempo)
            if (i < messages.length - 1) {
                await new Promise(r => setTimeout(r, intervaloMs));
            }
        }

        io.emit('bulk-done', { sent: enviados, total: messages.length });
    });

    socket.on('disconnect', () => {
        console.log('🔌 Cliente desconectado do painel:', socket.id);
    });
});

// ==================== ROTA DE STATUS (DEBUG) ====================
app.get('/api/status', (req, res) => {
    res.json({ connected: waReady, ...waInfo });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('🚀 Servidor ADEMICON rodando na porta ' + PORT);
});
