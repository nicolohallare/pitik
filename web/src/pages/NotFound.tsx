import { Link } from 'react-router-dom';
import { Layout } from '../components/ui';

export default function NotFound() {
  return (
    <Layout>
      <h1>Wala dito.</h1>
      <p className="lead">That page doesn't exist. <Link to="/">Go home</Link></p>
    </Layout>
  );
}
