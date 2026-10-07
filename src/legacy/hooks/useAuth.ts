import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/client';
import type { User as DatabaseUser } from '@/integrations/types';

export interface User {
  id: number;
  email: string;
  role: 'user' | 'doctor' | 'admin';
  name: string;
}

export const useAuth = () => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Check if user is logged in
    const isLoggedIn = localStorage.getItem('isLoggedIn');
    const userEmail = localStorage.getItem('userEmail');
    const userRole = localStorage.getItem('userRole') as 'user' | 'doctor' | 'admin';
    const userId = localStorage.getItem('userId');
    const userName = localStorage.getItem('userName');

    if (isLoggedIn === 'true' && userEmail && userRole && userId && userName) {
      setUser({
        id: parseInt(userId),
        email: userEmail,
        role: userRole,
        name: userName,
      });
    }
    setIsLoading(false);
  }, []);

  const login = async (email: string, role: 'user' | 'doctor' | 'admin') => {
    try {
      // Fetch user from database
      const { data: userData, error } = await supabase
        .from('users')
        .select('id, name, email, role')
        .eq('email', email)
        .eq('role', role)
        .single();

      if (error || !userData) {
        throw new Error('User not found');
      }

      // Type assertion to ensure userData is properly typed
      const typedUserData = userData as DatabaseUser;

      // Store user info in localStorage
      localStorage.setItem('isLoggedIn', 'true');
      localStorage.setItem('userEmail', typedUserData.email);
      localStorage.setItem('userRole', typedUserData.role);
      localStorage.setItem('userId', typedUserData.id.toString());
      localStorage.setItem('userName', typedUserData.name);
      
      setUser({
        id: typedUserData.id,
        email: typedUserData.email,
        role: typedUserData.role,
        name: typedUserData.name,
      });

      return typedUserData;
    } catch (error) {
      console.error('Login error:', error);
      throw error;
    }
  };

  const logout = () => {
    localStorage.removeItem('isLoggedIn');
    localStorage.removeItem('userEmail');
    localStorage.removeItem('userRole');
    localStorage.removeItem('userId');
    localStorage.removeItem('userName');
    setUser(null);
    window.location.href = '/';
  };

  return { user, isLoading, login, logout };
};