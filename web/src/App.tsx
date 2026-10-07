import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { CartProvider } from './lib/cart';
import { RequireAuth } from './components/ui';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Rider from './pages/Rider';
import RidePage from './pages/RidePage';
import Checkout from './pages/Checkout';
import OrderPage from './pages/OrderPage';
import Library from './pages/Library';
const Pitikero = lazy(() => import('./pages/Pitikero'));
const Admin = lazy(() => import('./pages/Admin'));
import Account from './pages/Account';
import Feedback from './pages/Feedback';
import Privacy from './pages/Privacy';
import NotFound from './pages/NotFound';

export default function App() {
  return (
    <AuthProvider>
      <CartProvider>
        <BrowserRouter>
          <Suspense fallback={<div className="wrap"><p className="note">Loading…</p></div>}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<Login />} />
            <Route path="/rider" element={<RequireAuth><Rider /></RequireAuth>} />
            <Route path="/ride/:id" element={<RequireAuth><RidePage /></RequireAuth>} />
            <Route path="/checkout" element={<RequireAuth><Checkout /></RequireAuth>} />
            <Route path="/order/:id" element={<RequireAuth><OrderPage /></RequireAuth>} />
            <Route path="/photos" element={<RequireAuth><Library /></RequireAuth>} />
            <Route path="/pitikero" element={<RequireAuth><Pitikero /></RequireAuth>} />
            <Route path="/admin" element={<RequireAuth><Admin /></RequireAuth>} />
            <Route path="/account" element={<RequireAuth><Account /></RequireAuth>} />
            <Route path="/feedback" element={<Feedback />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
        </BrowserRouter>
      </CartProvider>
    </AuthProvider>
  );
}
