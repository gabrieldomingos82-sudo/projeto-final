const express = require('express');
const cors = require('cors');
const axios = require('axios');
const app = express();

app.use(cors());
app.use(express.json());

// Rota para enviar mensagem via CallMeBot
app.get('/api/send-whatsapp', async (req, res) => {
    const { phone, text, apikey } = req.query;
    
    if (!phone || !text || !apikey) {
        return res.status(400).json({ error: 'Parâmetros faltando' });
    }
    
    try {
        const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(text)}&apikey=${apikey}`;
        const response = await axios.get(url);
        
        if (response.data.includes('Message sent') || response.data.includes('QUEUED')) {
            res.json({ success: true, message: 'Mensagem enviada!' });
        } else {
            res.json({ success: false, message: response.data });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Servir arquivos estáticos (frontend)
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('🚀 Servidor ADEMICON rodando na porta ' + PORT);
});