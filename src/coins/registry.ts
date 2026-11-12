// Lazy loaders for each wallet type's module (keeps the first load small).
import { registerCoin } from './module.ts';
void registerCoin;
