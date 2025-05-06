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

// Configuração CORS aprimorada
const corsOptions = {
  origin: [
    'http://localhost:8080',
    'https://seu-frontend.com' // Adicione seus domínios aqui
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// Configuração robusta do Socket.IO
const io = new Server(server, {
  cors: corsOptions,
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutos
    skipMiddlewares: true
  }
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

interface ExamePayload {
  senha: string;
  guiche: number;
  exames: string[];
  action: 'confirmar' | 'editar';
  id?: string;
}

interface Estado {
  filaSenhas: { [key in TipoSenha]: string[] };
  senhasChamadas: Chamada[];
  contadores: { O: number; L: number };
}

// Estado da aplicação com persistência inicial
const state: Estado = {
  filaSenhas: { O: [], L: [] },
  senhasChamadas: [],
  contadores: { O: 0, L: 0 }
};

// Utilitários
const gerarId = () => Math.random().toString(36).substring(2, 15);

// Configuração da Impressora
const PRINTER_IP = process.env.PRINTER_IP || '192.168.1.100';
const PRINTER_PORT = parseInt(process.env.PRINTER_PORT || '9100');
const PRINTER_TIMEOUT = parseInt(process.env.PRINTER_TIMEOUT || '5000');

// Função para gerar ZPL melhorada
const gerarZPL = (senha: string, tipo: TipoSenha): string => {
  const numeroSenha = senha.replace(tipo, '');
  const dataHora = new Date();
  
  return `^XA
^CF0,40
^FO50,30^FDClinica Médica^FS
^FO50,80^FDSenha: ${tipo}${numeroSenha.padStart(3, '0')}^FS
^CF0,30
^FO50,130^FDTipo: ${tipo === 'O' ? 'OCUPACIONAL' : 'LABORATORIAL'}^FS
^FO50,170^FDData: ${dataHora.toLocaleDateString('pt-BR')}^FS
^FO50,210^FDHora: ${dataHora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}^FS
^BY2,2,50
^FO50,260^BC^FD${tipo}${numeroSenha.padStart(3, '0')}^FS
^XZ`;
};

// Função robusta para imprimir na Zebra
const imprimirNaZebra = async (zpl: string): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let timeoutHandle: NodeJS.Timeout;

    // Configuração de timeout
    const cleanUp = () => {
      clearTimeout(timeoutHandle);
      client.destroy();
    };

    client.once('connect', () => {
      client.write(zpl, 'utf8', (err) => {
        cleanUp();
        if (err) {
          console.error('Erro ao enviar para impressora:', err);
          reject(err);
        } else {
          console.log('Dados enviados para impressora com sucesso');
          resolve(true);
        }
      });
    });

    client.on('error', (err) => {
      console.error('Erro de conexão com impressora:', err);
      cleanUp();
      reject(err);
    });

    client.on('timeout', () => {
      console.error('Timeout de conexão com impressora');
      cleanUp();
      reject(new Error('Timeout de conexão com impressora'));
    });

    timeoutHandle = setTimeout(() => {
      client.emit('timeout');
    }, PRINTER_TIMEOUT);

    try {
      client.connect({
        host: PRINTER_IP,
        port: PRINTER_PORT,
        noDelay: true
      });
    } catch (err) {
      cleanUp();
      reject(err);
    }
  });
};

// Middleware para logs
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Rotas de Impressão Aprimoradas
app.post('/imprimir-senha', async (req: Request, res: Response) => {
  try {
    const { senha, tipo } = req.body;

    if (!senha || !tipo) {
      return res.status(400).json({ 
        success: false,
        error: 'Parâmetros "senha" e "tipo" são obrigatórios' 
      });
    }

    if (!['O', 'L'].includes(tipo)) {
      return res.status(400).json({
        success: false,
        error: 'Tipo de senha inválido'
      });
    }

    const zpl = gerarZPL(senha, tipo as TipoSenha);
    await imprimirNaZebra(zpl);

    res.json({ 
      success: true, 
      message: 'Senha enviada para impressora',
      zpl: zpl // Opcional para debug
    });

  } catch (error) {
    console.error('Erro ao imprimir:', error);
    res.status(500).json({ 
      success: false,
      error: 'Erro ao conectar na impressora',
      details: error instanceof Error ? error.message : 'Erro desconhecido'
    });
  }
});

// Rotas principais com validação melhorada
app.post('/gerar', (req: Request, res: Response) => {
  try {
    const { tipo } = req.body;

    if (!tipo || !['O', 'L'].includes(tipo)) {
      return res.status(400).json({ 
        success: false,
        error: 'Tipo inválido. Use "O" ou "L".' 
      });
    }

    state.contadores[tipo as TipoSenha] += 1;
    const novaSenha = `${tipo}${String(state.contadores[tipo as TipoSenha]).padStart(3, '0')}`;
    state.filaSenhas[tipo as TipoSenha].push(novaSenha);

    io.emit('nova-senha', {
      senha: novaSenha,
      tipo,
      numero: state.contadores[tipo as TipoSenha],
      posicao: state.filaSenhas[tipo as TipoSenha].length
    });

    return res.json({ 
      success: true,
      senha: novaSenha, 
      numero: state.contadores[tipo as TipoSenha], 
      tipo 
    });

  } catch (error) {
    console.error('Erro em /gerar:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno no servidor'
    });
  }
});

/ Socket.IO com tratamento de erros robusto
io.on('connection', (socket) => {
  console.log(`Novo cliente conectado: ${socket.id}`);

  socket.on('error', (err) => {
    console.error(`Erro no socket ${socket.id}:`, err);
  });

  socket.emit('estado-inicial', {
    fila: state.filaSenhas,
    ultimasChamadas: state.senhasChamadas
      .filter(s => !s.finalizado)
      .slice(-5)
      .reverse()
  });

  socket.on('disconnect', (reason) => {
    console.log(`Cliente ${socket.id} desconectado: ${reason}`);
  });
});

// Middleware de erro centralizado
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Erro não tratado:', err.stack);
  res.status(500).json({ 
    success: false,
    error: 'Erro interno do servidor',
    requestId: req.id // Adicione um ID de requisição se estiver usando
  });
});

// Inicialização segura do servidor
const PORT = parseInt(process.env.PORT || '3001');
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Modo: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Impressora configurada em: ${PRINTER_IP}:${PRINTER_PORT}`);
});

// Limpeza periódica com tratamento de erros
setInterval(() => {
  try {
    const agora = new Date();
    const umDia = 24 * 60 * 60 * 1000;
    
    state.senhasChamadas = state.senhasChamadas.filter(s => {
      return !s.finalizado || (agora.getTime() - new Date(s.timestamp).getTime()) < umDia;
    });
  } catch (err) {
    console.error('Erro na limpeza periódica:', err);
  }
}, 3600000);

// Tratamento de sinais para desligamento gracioso
process.on('SIGTERM', () => {
  console.log('Recebido SIGTERM, encerrando servidor...');
  server.close(() => {
    console.log('Servidor encerrado');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Recebido SIGINT, encerrando servidor...');
  server.close(() => {
    console.log('Servidor encerrado');
    process.exit(0);
  });
});