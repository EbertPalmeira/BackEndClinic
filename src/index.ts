import express from 'express';
import { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import net from 'net';
import dotenv from 'dotenv';

// Configuração de ambiente
dotenv.config();

const app = express();
const server = createServer(app);

// Configuração CORS
app.use(cors({
  origin: ['http://localhost:8080', 'https://seu-frontend.com'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type'],
  credentials: true
}));

app.use(express.json());

// Configuração do Socket.IO
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:8080', 'https://seu-frontend.com'],
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
});

// Tipos e Interfaces
type TipoSenha = 'O' | 'L';

interface Chamada {
  id: string;
  senha: string;
  guiche: number;
  timestamp: Date;
  exames: string[];
  encaminhadoConsultorio?: boolean;
  finalizado?: boolean;
  atendido?: boolean;
  emAtendimento?: boolean;
  exameAtual?: string | null;
}

interface Estado {
  filaSenhas: { [key in TipoSenha]: string[] };
  senhasChamadas: Chamada[];
  contadores: { O: number; L: number };
}

interface ExamePayload {
  senha: string;
  guiche: number;
  exames: string[];
  action?: string;
  id?: string;
}

// Estado da aplicação
const state: Estado = {
  filaSenhas: { O: [], L: [] },
  senhasChamadas: [],
  contadores: { O: 0, L: 0 }
};

// Utilitários
const gerarId = () => Math.random().toString(36).substring(2, 15);

// Configuração da Impressora
const PRINTER_IP = process.env.PRINTER_IP || '192.168.1.100';
const PRINTER_PORT = 9100;

// Função para gerar ZPL (versão simplificada que já funcionou)
const gerarZPL = (senha: string): string => {
  return `^XA
^CF0,60
^FO100,100^FD${senha}^FS
^XZ`;
};

// Função de impressão MELHORADA
const imprimirNaZebra = async (zpl: string): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    if (!PRINTER_IP || PRINTER_IP === '0.0.0.0') {
      console.log('Impressão simulada (nenhum IP configurado)');
      return resolve(true);
    }

    const client = new net.Socket();
    let resolved = false;

    client.setTimeout(10000); // 10 segundos

    client.connect(PRINTER_PORT, PRINTER_IP, () => {
      console.log(`Conectado à impressora ${PRINTER_IP}:${PRINTER_PORT}`);
      
      client.write(zpl, 'ascii', (err) => {
        if (err && !resolved) {
          resolved = true;
          reject(err);
        } else if (!resolved) {
          resolved = true;
          resolve(true);
        }
        client.destroy();
      });
    });

    client.on('error', (err) => {
      console.error('Erro de conexão:', err);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
      client.destroy();
    });

    client.on('timeout', () => {
      console.error('Timeout de conexão');
      if (!resolved) {
        resolved = true;
        reject(new Error('Timeout de conexão com a impressora'));
      }
      client.destroy();
    });
  });
};

// ======================================
// ROTAS PRINCIPAIS (TODAS MANTIDAS)
// ======================================

// 1. Rota de teste de impressora
app.get('/teste-impressora', async (req: Request, res: Response) => {
  try {
    const zpl = gerarZPL('TESTE');
    const resultado = await imprimirNaZebra(zpl);
    
    res.json({
      success: resultado,
      message: resultado ? 
        'Teste enviado para impressora com sucesso' : 
        'Falha ao enviar teste para impressora'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erro ao testar impressora',
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

// 2. Gerar Senha (Original + impressão)
app.post('/gerar', async (req: Request, res: Response) => {
  try {
    const { tipo } = req.body;

    if (!tipo || !['O', 'L'].includes(tipo)) {
      return res.status(400).json({ error: 'Tipo inválido. Use "O" ou "L".' });
    }

    state.contadores[tipo as TipoSenha] += 1;
    const novaSenha = `${tipo}${String(state.contadores[tipo as TipoSenha]).padStart(3, '0')}`;
    state.filaSenhas[tipo as TipoSenha].push(novaSenha);

    // Tenta imprimir automaticamente
    try {
      const zpl = gerarZPL(novaSenha);
      await imprimirNaZebra(zpl);
    } catch (err) {
      console.error('Erro ao imprimir (não crítico):', err);
    }

    io.emit('nova-senha', {
      senha: novaSenha,
      tipo,
      numero: state.contadores[tipo as TipoSenha],
      posicao: state.filaSenhas[tipo as TipoSenha].length
    });

    return res.json({ 
      senha: novaSenha, 
      numero: state.contadores[tipo as TipoSenha], 
      tipo 
    });
  } catch (error) {
    console.error('Erro em /gerar:', error);
    return res.status(500).json({ 
      error: 'Erro interno ao gerar senha',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// 3. Chamar Senha para Guichê (Original)
app.post('/chamar', (req: Request, res: Response) => {
  const { guiche, senha } = req.body;

  if (!guiche || typeof guiche !== 'number' || guiche < 1 || guiche > 3) {
    return res.status(400).json({ error: 'Número do guichê inválido. Deve ser 1, 2 ou 3.' });
  }

  const tipoSenha = senha[0] as TipoSenha;

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

  const chamada: Chamada = {
    id: gerarId(),
    senha: senhaChamada,
    guiche,
    timestamp: new Date(),
    exames: [],
    finalizado: false,
    atendido: false,
    emAtendimento: false,
    exameAtual: null
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
});

// 4. Finalizar Atendimento (Original)
app.post('/finalizar-atendimento', (req: Request, res: Response) => {
  const { senha } = req.body;
  
  const chamada = state.senhasChamadas.find(s => s.senha === senha);
  if (!chamada) {
    return res.status(404).json({ error: 'Senha não encontrada' });
  }

  chamada.finalizado = true;
  chamada.atendido = true;
  chamada.emAtendimento = false;
  chamada.exameAtual = null;
  
  io.emit('senha-finalizada', { id: chamada.id });
  io.emit('atualizacao-atendimento', {
    id: chamada.id,
    emAtendimento: false,
    exameAtual: null
  });
  
  res.json({ sucesso: true });
});

// 5. Rotas para Consultório (Original)
app.post('/confirmar-exames', async (req: Request, res: Response) => {
  try {
    const { senha, guiche, exames, action, id }: ExamePayload = req.body;

    if (!senha || !guiche || !exames || !Array.isArray(exames)) {
      return res.status(400).json({ 
        sucesso: false,
        mensagem: 'Dados inválidos' 
      });
    }

    if (action === 'editar' && !id) {
      return res.status(400).json({
        sucesso: false,
        mensagem: 'ID é obrigatório para edição'
      });
    }

    let chamada = state.senhasChamadas.find(s => 
      action === 'editar' ? s.id === id : s.senha === senha && s.guiche === guiche
    );

    if (!chamada) {
      return res.status(404).json({
        sucesso: false,
        mensagem: 'Senha não encontrada'
      });
    }

    chamada.exames = [...new Set(exames)];

    if (action === 'confirmar') {
      chamada.encaminhadoConsultorio = true;
      chamada.emAtendimento = true;
      chamada.exameAtual = chamada.exames[0] || null;
    
      io.emit('atualizacao-atendimento', {
        id: chamada.id,
        emAtendimento: true,
        exameAtual: chamada.exameAtual
      });
    }
    
    return res.json({ sucesso: true, chamada });

  } catch (error) {
    console.error('Erro em confirmar-exames:', error);
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro interno no servidor'
    });
  }
});

// 6. Rota para Imprimir Senha (Alternativa)
app.post('/imprimir-senha', async (req: Request, res: Response) => {
  try {
    const { senha } = req.body;

    if (!senha) {
      return res.status(400).json({ error: 'Parâmetro "senha" é obrigatório' });
    }

    const zpl = gerarZPL(senha);
    const impressaoOk = await imprimirNaZebra(zpl);

    res.json({ 
      success: impressaoOk,
      message: impressaoOk ? 
        'Senha enviada para impressora' : 
        'Falha ao enviar para impressora',
      senha
    });

  } catch (error) {
    console.error('Erro ao imprimir:', error);
    res.status(500).json({ 
      error: 'Erro ao processar requisição',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Socket.IO (Original)
io.on('connection', (socket) => {
  console.log('Novo cliente conectado');
  
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

// Middleware de erro
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Endpoint não encontrado' });
});

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// Inicialização do servidor
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Configuração de impressora: ${PRINTER_IP || 'Desabilitada'}`);
  console.log(`Teste de impressora disponível em: http://localhost:${PORT}/teste-impressora`);
});