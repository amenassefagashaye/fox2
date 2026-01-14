import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// Types
interface Player {
  id: string;
  name: string;
  phone: string;
  stake: number;
  boardType: string;
  boardId: number;
  connected: boolean;
  socket: WebSocket;
  markedNumbers: number[];
  lastPing: number;
}

interface Admin {
  socket: WebSocket;
  authenticated: boolean;
}

interface GameState {
  status: 'waiting' | 'playing' | 'paused' | 'ended';
  calledNumbers: number[];
  currentNumber: number | null;
  autoCall: boolean;
  autoCallInterval: number | null;
  players: Map<string, Player>;
  winners: Array<{
    playerId: string;
    name: string;
    pattern: string;
    amount: number;
    time: Date;
  }>;
  finance: {
    totalIncome: number;
    totalPayout: number;
    currentBalance: number;
  };
}

// Game Server Class
class BingoServer {
  private gameState: GameState;
  private admin: Admin | null = null;
  private pingInterval: number | null = null;
  
  constructor() {
    this.gameState = {
      status: 'waiting',
      calledNumbers: [],
      currentNumber: null,
      autoCall: false,
      autoCallInterval: null,
      players: new Map(),
      winners: [],
      finance: {
        totalIncome: 0,
        totalPayout: 0,
        currentBalance: 0
      }
    };
    
    // Ping clients every 30 seconds
    this.pingInterval = setInterval(() => this.pingClients(), 30000) as unknown as number;
  }
  
  // Clean up intervals
  cleanup() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    if (this.gameState.autoCallInterval) {
      clearInterval(this.gameState.autoCallInterval);
    }
  }
  
  // Handle HTTP requests
  async handleRequest(req: Request): Promise<Response> {
    // Handle CORS preflight requests
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    
    const url = new URL(req.url);
    
    // Serve admin page
    if (url.pathname === '/admin') {
      try {
        const file = await Deno.readTextFile('./frontend/admin.html');
        return new Response(file, {
          headers: {
            'content-type': 'text/html',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (error) {
        console.error('Error reading admin.html:', error);
        return new Response('Admin page not found', { 
          status: 404,
          headers: {
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }
    
    // Serve player page
    if (url.pathname === '/' || url.pathname === '/index.html') {
      try {
        const file = await Deno.readTextFile('./frontend/index.html');
        return new Response(file, {
          headers: {
            'content-type': 'text/html',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (error) {
        console.error('Error reading index.html:', error);
        return new Response('Game page not found', { 
          status: 404,
          headers: {
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }
    
    // Serve static files
    if (url.pathname.startsWith('/frontend/')) {
      try {
        const filePath = `.${url.pathname}`;
        const file = await Deno.readFile(filePath);
        const contentType = this.getContentType(url.pathname);
        return new Response(file, {
          headers: {
            'content-type': contentType,
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (error) {
        console.error('Error reading static file:', error);
        return new Response('File not found', { 
          status: 404,
          headers: {
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }
    
    // WebSocket upgrade
    if (url.pathname === '/ws') {
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response(null, { status: 501 });
      }
      
      const { socket, response } = Deno.upgradeWebSocket(req);
      this.handleWebSocket(socket);
      return response;
    }
    
    // API endpoints
    if (url.pathname === '/api/game-state') {
      const gameState = {
        status: this.gameState.status,
        calledNumbers: this.gameState.calledNumbers,
        currentNumber: this.gameState.currentNumber,
        playerCount: this.gameState.players.size,
        autoCall: this.gameState.autoCall
      };
      
      return new Response(JSON.stringify(gameState), {
        headers: {
          'content-type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    return new Response('Not found', { 
      status: 404,
      headers: {
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
  
  // Handle WebSocket connections
  handleWebSocket(socket: WebSocket) {
    console.log('New WebSocket connection');
    
    socket.onopen = () => {
      console.log('WebSocket connection established');
      this.sendToSocket(socket, {
        type: 'connection_established',
        message: 'Connected to Bingo Server',
        timestamp: new Date().toISOString()
      });
    };
    
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleMessage(socket, data);
      } catch (error) {
        console.error('Failed to parse message:', error);
        this.sendToSocket(socket, {
          type: 'error',
          message: 'Invalid message format'
        });
      }
    };
    
    socket.onclose = () => {
      console.log('WebSocket connection closed');
      this.handleDisconnect(socket);
    };
    
    socket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }
  
  // Handle incoming messages
  async handleMessage(socket: WebSocket, data: any) {
    try {
      switch (data.type) {
        case 'admin_auth':
          this.handleAdminAuth(socket, data.password);
          break;
          
        case 'player_connect':
          this.handlePlayerConnect(socket, data.playerId, data.playerName);
          break;
          
        case 'player_register':
          this.handlePlayerRegister(socket, data);
          break;
          
        case 'mark_number':
          this.handleMarkNumber(socket, data.playerId, data.number);
          break;
          
        case 'claim_win':
          this.handleClaimWin(socket, data);
          break;
          
        case 'start_game':
          this.handleStartGame();
          break;
          
        case 'pause_game':
          this.handlePauseGame();
          break;
          
        case 'end_game':
          this.handleEndGame();
          break;
          
        case 'call_number':
          this.callRandomNumber();
          break;
          
        case 'toggle_auto_call':
          this.toggleAutoCall(data.enabled);
          break;
          
        case 'clear_numbers':
          this.clearCalledNumbers();
          break;
          
        case 'ping':
          this.handlePing(socket, data.playerId);
          break;
          
        case 'get_players':
          this.sendPlayersUpdate(socket);
          break;
          
        default:
          console.log('Unknown message type:', data.type);
          this.sendToSocket(socket, {
            type: 'error',
            message: `Unknown message type: ${data.type}`
          });
      }
    } catch (error) {
      console.error('Error handling message:', error);
      this.sendToSocket(socket, {
        type: 'error',
        message: 'Internal server error'
      });
    }
  }
  
  // Admin authentication
  handleAdminAuth(socket: WebSocket, password: string) {
    const ADMIN_PASSWORD = 'asse2123';
    
    if (password === ADMIN_PASSWORD) {
      this.admin = { socket, authenticated: true };
      this.sendToSocket(socket, {
        type: 'auth_success',
        message: 'Admin authenticated successfully',
        timestamp: new Date().toISOString()
      });
      this.sendGameStateToAdmin();
      console.log('Admin authenticated');
    } else {
      this.sendToSocket(socket, {
        type: 'auth_failed',
        message: 'Invalid password'
      });
      socket.close(1008, 'Invalid password');
    }
  }
  
  // Player connection
  handlePlayerConnect(socket: WebSocket, playerId: string, playerName: string) {
    let player = this.gameState.players.get(playerId);
    
    if (player) {
      // Reconnecting player
      player.socket = socket;
      player.connected = true;
      player.lastPing = Date.now();
      console.log(`Player reconnected: ${player.name} (${playerId})`);
    } else {
      // New player
      player = {
        id: playerId,
        name: playerName || 'Guest',
        phone: '',
        stake: 0,
        boardType: '75ball',
        boardId: Math.floor(Math.random() * 100) + 1,
        connected: true,
        socket,
        markedNumbers: [],
        lastPing: Date.now()
      };
      this.gameState.players.set(playerId, player);
      console.log(`New player connected: ${playerName} (${playerId})`);
    }
    
    // Send current game state to player
    this.sendToSocket(socket, {
      type: 'game_state',
      state: {
        status: this.gameState.status,
        calledNumbers: this.gameState.calledNumbers,
        currentNumber: this.gameState.currentNumber,
        autoCall: this.gameState.autoCall,
        playerCount: this.gameState.players.size
      }
    });
    
    // Notify admin
    this.sendPlayersUpdateToAdmin();
  }
  
  // Player registration
  handlePlayerRegister(socket: WebSocket, data: any) {
    const player = this.gameState.players.get(data.playerId);
    if (player) {
      player.name = data.name;
      player.phone = data.phone;
      player.stake = data.stake;
      player.boardType = data.boardType;
      
      // Add to finance
      this.gameState.finance.totalIncome += data.stake;
      this.gameState.finance.currentBalance += data.stake;
      
      // Send confirmation to player
      this.sendToSocket(socket, {
        type: 'registration_success',
        message: 'Registration successful',
        playerId: player.id,
        boardId: player.boardId
      });
      
      // Broadcast to admin
      this.sendPlayersUpdateToAdmin();
      this.sendFinanceUpdateToAdmin();
      
      // Notify all players about new player
      this.broadcastToAllPlayers({
        type: 'player_joined',
        playerId: player.id,
        playerName: player.name,
        playerCount: this.gameState.players.size
      });
      
      console.log(`Player registered: ${player.name} with stake ${player.stake}`);
    }
  }
  
  // Mark number
  handleMarkNumber(socket: WebSocket, playerId: string, number: number) {
    const player = this.gameState.players.get(playerId);
    if (player && !player.markedNumbers.includes(number)) {
      player.markedNumbers.push(number);
      
      this.sendToSocket(socket, {
        type: 'number_marked',
        number: number,
        markedNumbers: player.markedNumbers
      });
    }
  }
  
  // Claim win
  handleClaimWin(socket: WebSocket, data: any) {
    if (this.gameState.status !== 'playing') {
      this.sendToSocket(socket, {
        type: 'error',
        message: 'Game is not active'
      });
      return;
    }
    
    const player = this.gameState.players.get(data.playerId);
    if (!player) {
      this.sendToSocket(socket, {
        type: 'error',
        message: 'Player not found'
      });
      return;
    }
    
    // Check win pattern (simplified logic)
    const winPattern = this.checkWinPattern(player.markedNumbers, data.boardType);
    
    if (winPattern) {
      const winAmount = this.calculateWinAmount(player.stake);
      
      // Add to winners
      const winner = {
        playerId: player.id,
        name: player.name,
        pattern: winPattern,
        amount: winAmount,
        time: new Date()
      };
      
      this.gameState.winners.push(winner);
      
      // Update finance
      this.gameState.finance.totalPayout += winAmount;
      this.gameState.finance.currentBalance -= winAmount;
      
      // Broadcast win to all
      this.broadcastToAllPlayers({
        type: 'winner_declared',
        winner: {
          name: player.name,
          pattern: winPattern,
          amount: winAmount,
          timestamp: new Date().toISOString()
        }
      });
      
      // Send confirmation to winner
      this.sendToSocket(socket, {
        type: 'win_confirmed',
        pattern: winPattern,
        amount: winAmount,
        message: 'Congratulations! You won!'
      });
      
      // Notify admin
      this.sendWinnersUpdateToAdmin();
      this.sendFinanceUpdateToAdmin();
      
      console.log(`Winner declared: ${player.name} won ${winAmount} with pattern ${winPattern}`);
    } else {
      this.sendToSocket(socket, {
        type: 'error',
        message: 'No winning pattern found'
      });
    }
  }
  
  // Start game
  handleStartGame() {
    if (this.gameState.status === 'waiting' || this.gameState.status === 'ended') {
      this.gameState.status = 'playing';
      this.gameState.calledNumbers = [];
      this.gameState.currentNumber = null;
      
      // Reset player marked numbers
      this.gameState.players.forEach(player => {
        player.markedNumbers = [];
      });
      
      // Broadcast game start
      this.broadcastToAllPlayers({
        type: 'game_started',
        message: 'Game started! Numbers will be called soon.',
        timestamp: new Date().toISOString()
      });
      
      this.sendGameStateToAdmin();
      console.log('Game started');
    }
  }
  
  // Pause game
  handlePauseGame() {
    if (this.gameState.status === 'playing') {
      this.gameState.status = 'paused';
      this.broadcastToAllPlayers({
        type: 'game_paused',
        message: 'Game paused by admin'
      });
      this.sendGameStateToAdmin();
      console.log('Game paused');
    } else if (this.gameState.status === 'paused') {
      this.gameState.status = 'playing';
      this.broadcastToAllPlayers({
        type: 'game_resumed',
        message: 'Game resumed'
      });
      this.sendGameStateToAdmin();
      console.log('Game resumed');
    }
  }
  
  // End game
  handleEndGame() {
    this.gameState.status = 'ended';
    this.broadcastToAllPlayers({
      type: 'game_ended',
      message: 'Game has ended. Thank you for playing!',
      winners: this.gameState.winners.slice(-5)
    });
    this.sendGameStateToAdmin();
    console.log('Game ended');
  }
  
  // Call random number
  callRandomNumber() {
    if (this.gameState.status !== 'playing') {
      return;
    }
    
    let number: number;
    const maxNumber = 75; // Standard bingo range
    
    // Generate unique number
    do {
      number = Math.floor(Math.random() * maxNumber) + 1;
    } while (this.gameState.calledNumbers.includes(number));
    
    this.gameState.calledNumbers.push(number);
    this.gameState.currentNumber = number;
    
    // Broadcast to all players
    this.broadcastToAllPlayers({
      type: 'number_called',
      number: number,
      calledNumbers: this.gameState.calledNumbers,
      totalCalled: this.gameState.calledNumbers.length
    });
    
    // Update admin
    this.sendCalledNumbersToAdmin();
    
    console.log(`Number called: ${number}`);
    
    return number;
  }
  
  // Toggle auto-call
  toggleAutoCall(enabled: boolean) {
    if (enabled && !this.gameState.autoCallInterval) {
      this.gameState.autoCall = true;
      this.gameState.autoCallInterval = setInterval(() => {
        this.callRandomNumber();
      }, 7000) as unknown as number;
      
      console.log('Auto-call enabled');
    } else if (!enabled && this.gameState.autoCallInterval) {
      this.gameState.autoCall = false;
      clearInterval(this.gameState.autoCallInterval);
      this.gameState.autoCallInterval = null;
      console.log('Auto-call disabled');
    }
    
    this.sendGameStateToAdmin();
  }
  
  // Clear called numbers
  clearCalledNumbers() {
    this.gameState.calledNumbers = [];
    this.gameState.currentNumber = null;
    this.sendCalledNumbersToAdmin();
    console.log('Called numbers cleared');
  }
  
  // Check win pattern (simplified)
  checkWinPattern(markedNumbers: number[], boardType: string): string | null {
    // Basic win check - at least 5 numbers marked
    if (markedNumbers.length >= 5) {
      if (boardType === '75ball' || boardType === '50ball') {
        return 'Row Pattern';
      } else if (boardType === '90ball') {
        return 'Line Pattern';
      } else if (boardType === 'pattern') {
        return 'Special Pattern';
      }
      return 'Full House';
    }
    return null;
  }
  
  // Calculate win amount
  calculateWinAmount(stake: number): number {
    // 80% of total stakes from 90 players, minus 3% service fee
    const totalPot = 90 * stake * 0.8;
    return Math.floor(totalPot * 0.97);
  }
  
  // Handle ping
  handlePing(socket: WebSocket, playerId: string) {
    const player = this.gameState.players.get(playerId);
    if (player) {
      player.lastPing = Date.now();
    }
    this.sendToSocket(socket, { type: 'pong', timestamp: Date.now() });
  }
  
  // Send players list
  sendPlayersUpdate(socket: WebSocket) {
    const players = Array.from(this.gameState.players.values()).map(player => ({
      id: player.id,
      name: player.name,
      stake: player.stake,
      board: player.boardId,
      connected: player.connected,
      markedCount: player.markedNumbers.length
    }));
    
    this.sendToSocket(socket, {
      type: 'players_update',
      players: players,
      count: players.length
    });
  }
  
  // Ping clients
  pingClients() {
    const now = Date.now();
    const disconnectedPlayers: string[] = [];
    
    // Ping players
    this.gameState.players.forEach(player => {
      if (now - player.lastPing > 120000) { // 2 minutes timeout
        player.connected = false;
        disconnectedPlayers.push(player.id);
      } else if (player.connected && player.socket.readyState === WebSocket.OPEN) {
        this.sendToSocket(player.socket, { 
          type: 'ping',
          timestamp: now 
        });
      }
    });
    
    // Remove disconnected players
    disconnectedPlayers.forEach(id => {
      this.gameState.players.delete(id);
    });
    
    // Update admin if there were disconnections
    if (disconnectedPlayers.length > 0) {
      this.sendPlayersUpdateToAdmin();
      console.log(`Removed ${disconnectedPlayers.length} disconnected players`);
    }
  }
  
  // Handle disconnect
  handleDisconnect(socket: WebSocket) {
    // Check if admin disconnected
    if (this.admin && this.admin.socket === socket) {
      this.admin = null;
      console.log('Admin disconnected');
      return;
    }
    
    // Find and mark player as disconnected
    for (const [id, player] of this.gameState.players) {
      if (player.socket === socket) {
        player.connected = false;
        player.lastPing = Date.now();
        this.sendPlayersUpdateToAdmin();
        console.log(`Player disconnected: ${player.name} (${id})`);
        
        // Notify other players
        this.broadcastToAllPlayers({
          type: 'player_left',
          playerId: id,
          playerName: player.name,
          playerCount: this.gameState.players.size
        });
        break;
      }
    }
  }
  
  // Send to specific socket
  sendToSocket(socket: WebSocket, data: any) {
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(data));
      } catch (error) {
        console.error('Error sending to socket:', error);
      }
    }
  }
  
  // Broadcast to all players
  broadcastToAllPlayers(data: any) {
    this.gameState.players.forEach(player => {
      if (player.connected && player.socket.readyState === WebSocket.OPEN) {
        this.sendToSocket(player.socket, data);
      }
    });
  }
  
  // Send game state to admin
  sendGameStateToAdmin() {
    if (this.admin && this.admin.authenticated && this.admin.socket.readyState === WebSocket.OPEN) {
      this.sendToSocket(this.admin.socket, {
        type: 'game_state',
        state: {
          status: this.gameState.status,
          autoCall: this.gameState.autoCall,
          paused: this.gameState.status === 'paused',
          playerCount: this.gameState.players.size,
          calledNumbersCount: this.gameState.calledNumbers.length
        }
      });
    }
  }
  
  // Send players list to admin
  sendPlayersUpdateToAdmin() {
    if (this.admin && this.admin.authenticated && this.admin.socket.readyState === WebSocket.OPEN) {
      const players = Array.from(this.gameState.players.values()).map(player => ({
        id: player.id,
        name: player.name,
        stake: player.stake,
        board: player.boardId,
        connected: player.connected,
        markedCount: player.markedNumbers.length,
        phone: player.phone
      }));
      
      this.sendToSocket(this.admin.socket, {
        type: 'players_update',
        players: players,
        count: players.length
      });
    }
  }
  
  // Send called numbers to admin
  sendCalledNumbersToAdmin() {
    if (this.admin && this.admin.authenticated && this.admin.socket.readyState === WebSocket.OPEN) {
      this.sendToSocket(this.admin.socket, {
        type: 'called_numbers',
        numbers: this.gameState.calledNumbers,
        currentNumber: this.gameState.currentNumber
      });
    }
  }
  
  // Send winners to admin
  sendWinnersUpdateToAdmin() {
    if (this.admin && this.admin.authenticated && this.admin.socket.readyState === WebSocket.OPEN) {
      this.sendToSocket(this.admin.socket, {
        type: 'winners_update',
        winners: this.gameState.winners.slice(-10), // Last 10 winners
        totalWinners: this.gameState.winners.length
      });
    }
  }
  
  // Send finance update to admin
  sendFinanceUpdateToAdmin() {
    if (this.admin && this.admin.authenticated && this.admin.socket.readyState === WebSocket.OPEN) {
      this.sendToSocket(this.admin.socket, {
        type: 'finance_update',
        finance: this.gameState.finance
      });
    }
  }
  
  // Get content type for static files
  getContentType(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'html': return 'text/html; charset=utf-8';
      case 'css': return 'text/css; charset=utf-8';
      case 'js': return 'application/javascript; charset=utf-8';
      case 'json': return 'application/json; charset=utf-8';
      case 'png': return 'image/png';
      case 'jpg': case 'jpeg': return 'image/jpeg';
      case 'gif': return 'image/gif';
      case 'svg': return 'image/svg+xml';
      case 'ico': return 'image/x-icon';
      case 'ttf': return 'font/ttf';
      case 'woff': return 'font/woff';
      case 'woff2': return 'font/woff2';
      default: return 'application/octet-stream';
    }
  }
}

// Create server instance
const bingoServer = new BingoServer();

// Handle cleanup on process termination
globalThis.addEventListener('unload', () => {
  bingoServer.cleanup();
});

// Start server
console.log('🚀 Bingo server starting...');

serve((req) => bingoServer.handleRequest(req), {
  port: 8080,
  onListen: ({ port, hostname }) => {
    console.log(`✅ Bingo server running on http://${hostname}:${port}`);
    console.log(`🌐 Player interface: http://${hostname}:${port}`);
    console.log(`🔧 Admin panel: http://${hostname}:${port}/admin?admin=true`);
    console.log(`📡 WebSocket endpoint: ws://${hostname}:${port}/ws`);
    console.log(`📊 API endpoint: http://${hostname}:${port}/api/game-state`);
  },
});

// Export for testing
export { BingoServer };
