import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export default function Forbidden() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100">
      <div className="text-center">
        <h1 className="mb-4 text-4xl font-bold">403</h1>
        <p className="mb-4 text-xl text-gray-600">You do not have access to this page.</p>
        <Button asChild variant="outline">
          <Link to="/app">Go to my dashboard</Link>
        </Button>
      </div>
    </div>
  );
}
