import { useState } from 'react';
import { useApp } from '../store';

export default function LoginPage() {
  const setUser = useApp((s) => s.setUser);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await window.api.auth.login(username.trim(), password);
      if (!res.ok) {
        setError(res.error ?? 'Login failed');
        return;
      }
      setUser(res.user);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full flex items-center justify-center bg-gradient-to-br from-orange-50 to-orange-100">
      <form
        onSubmit={submit}
        className="bg-white rounded-2xl shadow-xl p-10 w-[400px] border border-gray-100"
      >
        <h1 className="text-3xl font-bold text-center text-brand-700 mb-1">Restaurant POS</h1>
        <p className="text-center text-gray-500 text-sm mb-8">Sign in to continue</p>

        <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full mb-4 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
          autoFocus
          required
        />

        <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full mb-4 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
          required
        />

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 disabled:opacity-50"
        >
          {loading ? 'Signing in…' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}
