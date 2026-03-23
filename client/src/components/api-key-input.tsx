import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getApiKey, setApiKey, clearApiKey } from '@/lib/openai';
import { Key, Eye, EyeOff, Check, X } from 'lucide-react';

interface ApiKeyInputProps {
  onKeyChange: (hasKey: boolean) => void;
}

export function ApiKeyInput({ onKeyChange }: ApiKeyInputProps) {
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);

  useEffect(() => {
    const storedKey = getApiKey();
    if (storedKey) {
      setKey(storedKey);
      setHasStoredKey(true);
      onKeyChange(true);
    }
  }, [onKeyChange]);

  const handleKeyChange = (value: string) => {
    setKey(value);
    const trimmedValue = value.trim();

    if (!trimmedValue) {
      clearApiKey();
      setHasStoredKey(false);
      onKeyChange(false);
      return;
    }

    if (trimmedValue.startsWith('sk-')) {
      setApiKey(trimmedValue);
      setHasStoredKey(true);
      onKeyChange(true);
    }
  };

  const handleClear = () => {
    clearApiKey();
    setKey('');
    setHasStoredKey(false);
    onKeyChange(false);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Key className="w-5 h-5 text-primary" />
          OpenAI API Key
        </CardTitle>
        <CardDescription>
          Stored only in this browser so the static GitHub Pages app can call OpenAI directly
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              data-testid="input-api-key"
              type={showKey ? 'text' : 'password'}
              value={key}
              onChange={(e) => handleKeyChange(e.target.value)}
              placeholder="sk-..."
              className="pr-10"
            />
            <Button
              data-testid="button-toggle-key-visibility"
              size="sm"
              variant="ghost"
              className="absolute right-1 top-1/2 -translate-y-1/2"
              onClick={() => setShowKey(!showKey)}
            >
              {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </Button>
          </div>
          {hasStoredKey && (
            <Button
              data-testid="button-clear-key"
              size="icon"
              variant="outline"
              onClick={handleClear}
            >
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>
        {hasStoredKey && (
          <div className="flex items-center gap-1.5 mt-2 text-sm text-green-600 dark:text-green-400">
            <Check className="w-4 h-4" />
            <span>API key saved</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
