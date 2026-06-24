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
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const candidatos = [
        path.join(process.env.HOME || '/opt/render', '.cache/puppeteer'),
        '/opt/render/.cache/puppeteer'
    ];

    for (const base of candidatos) {
        try {
            if (!fs.existsSync(base)) continue;
            const chromeDir = path.join(base, 'chrome');
            if (!fs.existsSync(chromeDir)) continue;
            // estrutura típica: <base>/chrome/linux-<versão>/chrome-linux64/chrome
            const versoes = fs.readdirSync(chromeDir);
            for (const v of versoes) {
                const possivel = path.join(chromeDir, v, 'chrome-linux64', 'chrome');
                if (fs.existsSync(possivel)) return possivel;
            }
        } catch (e) {
            // ignora e tenta o próximo candidato
        }
    }

    console.warn('⚠️ Não foi possível localizar o Chrome automaticamente. Usando o padrão do Puppeteer.');
    return undefined;
}

// ==================== CRIAÇÃO DO CLIENTE WHATSAPP ====================
// Usa LocalAuth para persistir a sessão em disco (./.wwebjs_auth),
// assim depois de escanear o QR Code uma vez, reinícios do processo
// (ex.: deploy novo no Render) não exigem escanear de novo - só
// se o disco for limpo (no Render free, o disco É temporário entre
// deploys, mas sobrevive a "sleeps" por inatividade).
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
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--disable-translate',
                '--metrics-recording-only',
                '--mute-audio',
                '--js-flags=--max-old-space-size=256'
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
