import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type CartItem = { id: string; pitikero_id: string; pitikero: string; price: number; thumb: string; taken_at: string };
type Ctx = {
  items: Record<string, CartItem>; tips: Record<string, number>;
  toggle: (it: CartItem) => void; has: (id: string) => boolean; setTip: (pk: string, v: number) => void; clear: () => void;
};
const CartCtx = createContext<Ctx>(null as unknown as Ctx);
const KEY = 'pitik.cart.v1';

function read() {
  try { return JSON.parse(sessionStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const init = read();
  const [items, setItems] = useState<Record<string, CartItem>>(init.items ?? {});
  const [tips, setTips] = useState<Record<string, number>>(init.tips ?? {});
  useEffect(() => { try { sessionStorage.setItem(KEY, JSON.stringify({ items, tips })); } catch { /* private mode */ } }, [items, tips]);
  const value: Ctx = {
    items, tips,
    toggle: (it) => setItems((m) => { const n = { ...m }; if (n[it.id]) delete n[it.id]; else n[it.id] = it; return n; }),
    has: (id) => !!items[id],
    setTip: (pk, v) => setTips((t) => ({ ...t, [pk]: v })),
    clear: () => { setItems({}); setTips({}); },
  };
  return <CartCtx.Provider value={value}>{children}</CartCtx.Provider>;
}
export const useCart = () => useContext(CartCtx);
