"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const cors_1 = __importDefault(require("cors"));
const app = (0, express_1.default)();
const server = (0, http_1.createServer)(app);
// Configuração do CORS
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// Configuração do Socket.IO
const io = new socket_io_1.Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
// Estado principal
const state = {
    filaSenhas: {
        O: [],
        L: []
    },
    senhasChamadas: [],
    contadores: {
        O: 0,
        L: 0
    }
};
// Função para gerar ID único
const gerarId = () => Math.random().toString(36).substring(2, 15);
// Rotas principais
app.post('/gerar', (req, res) => {
    const { tipo } = req.body;
    if (!tipo || !['O', 'L'].includes(tipo)) {
        return res.status(400).json({ error: 'Tipo inválido. Use "O" ou "L".' });
    }
    state.contadores[tipo] += 1;
    const novaSenha = `${tipo}${String(state.contadores[tipo]).padStart(3, '0')}`;
    state.filaSenhas[tipo].push(novaSenha);
    io.emit('nova-senha', {
        senha: novaSenha,
        tipo,
        numero: state.contadores[tipo],
        posicao: state.filaSenhas[tipo].length
    });
    res.json({ senha: novaSenha, numero: state.contadores[tipo], tipo });
});
app.post('/chamar', (req, res) => {
    const { guiche, senha } = req.body;
    if (!guiche || typeof guiche !== 'number' || guiche < 1 || guiche > 3) {
        return res.status(400).json({ error: 'Número do guichê inválido. Deve ser 1, 2 ou 3.' });
    }
    const tipoSenha = senha[0];
    if (state.filaSenhas[tipoSenha].length === 0) {
        return res.status(400).json({ error: 'Senha não encontrada na fila' });
    }
    const senhaIndex = state.filaSenhas[tipoSenha].indexOf(senha);
    if (senhaIndex === -1) {
        return res.status(400).json({ error: 'Senha não encontrada na fila' });
    }
    if (tipoSenha === 'O' && guiche === 3) {
        return res.status(400).json({ error: 'Senha ocupacional não pode ser chamada no guichê 3' });
    }
    if (tipoSenha === 'L' && guiche !== 3) {
        return res.status(400).json({ error: 'Senha laboratorial só pode ser chamada no guichê 3' });
    }
    const senhaChamada = state.filaSenhas[tipoSenha].splice(senhaIndex, 1)[0];
    const chamada = {
        id: gerarId(),
        senha: senhaChamada,
        guiche,
        timestamp: new Date(),
        exames: [],
        finalizado: false,
        atendido: false
    };
    state.senhasChamadas.push(chamada);
    io.emit('senha-chamada', chamada);
    io.emit('atualizacao-fila', {
        fila: state.filaSenhas,
        ultimasChamadas: state.senhasChamadas
            .filter(s => !s.finalizado)
            .slice(-5)
            .reverse()
    });
    io.emit('senha-chamada-exames', { senha: senhaChamada, guiche });
    res.json(chamada);
    res.json(chamada);
});
app.post('/finalizar-atendimento', (req, res) => {
    const { senha } = req.body;
    const chamada = state.senhasChamadas.find(s => s.senha === senha);
    if (!chamada) {
        return res.status(404).json({ error: 'Senha não encontrada' });
    }
    chamada.finalizado = true;
    chamada.atendido = true;
    io.emit('senha-finalizada', { id: chamada.id });
    res.json({ sucesso: true });
});
app.get('/senhas-chamadas-exames', (req, res) => {
    const senhasFiltradas = state.senhasChamadas
        .filter(s => !s.finalizado && !s.encaminhadoConsultorio)
        .reduce((acc, curr) => {
        acc[curr.guiche] = curr.senha;
        return acc;
    }, {});
    res.json(senhasFiltradas);
});
// Rotas para consultório
app.post('/confirmar-exames', (req, res) => {
    const { senha, guiche, exames } = req.body;
    if (!senha || !guiche || !exames || !Array.isArray(exames)) {
        return res.status(400).json({ error: 'Dados inválidos' });
    }
    const chamadaExistente = state.senhasChamadas.find(s => s.senha === senha && s.guiche === guiche && !s.finalizado);
    if (!chamadaExistente) {
        return res.status(404).json({ error: 'Senha não encontrada para esse guichê' });
    }
    const examesNormalizados = [...new Set(exames.map(e => e.trim()))];
    chamadaExistente.exames = examesNormalizados;
    chamadaExistente.encaminhadoConsultorio = true;
    io.emit('senha-consultorio', {
        id: chamadaExistente.id,
        senha,
        exames: examesNormalizados,
        guicheOrigem: guiche,
        timestamp: new Date(),
        finalizado: false,
        atendido: false
    });
    res.json({
        sucesso: true,
        senha,
        exames: examesNormalizados
    });
});
app.post('/marcar-atendido', (req, res) => {
    const { id } = req.body;
    const chamada = state.senhasChamadas.find(s => s.id === id);
    if (!chamada) {
        return res.status(404).json({ error: 'Senha não encontrada' });
    }
    chamada.finalizado = true;
    chamada.atendido = true;
    io.emit('senha-finalizada', { id });
    io.emit('atualizacao-fila', {
        fila: state.filaSenhas,
        ultimasChamadas: state.senhasChamadas
            .filter(s => !s.finalizado)
            .slice(-5)
            .reverse()
    });
    res.json({ sucesso: true });
});
app.get('/senhas-consultorio', (req, res) => {
    const apenasNaoAtendidos = req.query.apenasNaoAtendidos === 'true';
    let senhasFiltradas = state.senhasChamadas
        .filter(s => s.exames && s.exames.length > 0 && s.encaminhadoConsultorio);
    if (apenasNaoAtendidos) {
        senhasFiltradas = senhasFiltradas.filter(s => !s.atendido);
    }
    res.json(senhasFiltradas.map(s => ({
        id: s.id,
        senha: s.senha,
        exames: s.exames,
        guicheOrigem: s.guiche,
        timestamp: s.timestamp
    })));
});
app.post('/remover-exame', (req, res) => {
    const { id, exame } = req.body;
    if (!id || !exame) {
        return res.status(400).json({ error: 'ID e exame são obrigatórios' });
    }
    // Procura a senha no array de chamadas
    const chamada = state.senhasChamadas.find(c => c.id === id);
    if (!chamada) {
        return res.status(404).json({ error: 'Paciente não encontrado' });
    }
    // Verifica se o exame existe na lista
    if (!chamada.exames || !chamada.exames.includes(exame)) {
        return res.status(400).json({ error: 'Exame não encontrado para este paciente' });
    }
    // Remove o exame da lista de exames
    chamada.exames = chamada.exames.filter(e => e !== exame);
    // Se o paciente não tiver mais exames, marca como atendido
    if (chamada.exames.length === 0) {
        chamada.atendido = true;
        chamada.finalizado = true;
    }
    io.emit('senha-consultorio', state.senhasChamadas.filter(s => s.exames && s.exames.length > 0 && !s.atendido));
    res.json({
        success: true,
        message: 'Exame removido com sucesso',
        paciente: {
            id: chamada.id,
            examesRestantes: chamada.exames,
            atendido: chamada.atendido
        }
    });
});
// Rotas de consulta
app.get('/estado', (req, res) => {
    res.json({
        fila: state.filaSenhas,
        ultimasChamadas: state.senhasChamadas
            .filter(s => !s.finalizado)
            .slice(-5)
            .reverse(),
        contadores: state.contadores
    });
});
// Socket.IO
io.on('connection', (socket) => {
    console.log('Novo cliente conectado');
    // Envia estado inicial ao conectar
    socket.emit('estado-inicial', {
        fila: state.filaSenhas,
        ultimasChamadas: state.senhasChamadas
            .filter(s => !s.finalizado)
            .slice(-5)
            .reverse()
    });
    socket.on('disconnect', () => {
        console.log('Cliente desconectado');
    });
});
// Limpeza periódica de senhas finalizadas
setInterval(() => {
    const agora = new Date();
    const umDia = 24 * 60 * 60 * 1000;
    state.senhasChamadas = state.senhasChamadas.filter(s => {
        return !s.finalizado || (agora.getTime() - new Date(s.timestamp).getTime()) < umDia;
    });
}, 3600000); // A cada hora
// Inicialização do servidor
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
