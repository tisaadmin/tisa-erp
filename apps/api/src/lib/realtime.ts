import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from '../config';
import { loadAuthUser, verifyAccessToken } from '../middleware/auth';

let io: Server | null = null;

export function initRealtime(server: HttpServer) {
  io = new Server(server, { cors: { origin: env.CORS_ORIGINS, credentials: true } });
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) return next(new Error('unauthorized'));
      const user = await loadAuthUser(verifyAccessToken(token));
      if (!user) return next(new Error('unauthorized'));
      socket.data.userId = user.id;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    socket.join(`user:${socket.data.userId}`);
  });
  return io;
}

export function emitToUser(userId: string, event: string, payload: unknown) {
  io?.to(`user:${userId}`).emit(event, payload);
}
