import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ScriptOption } from '@/lib/script-catalog';
import { FileText } from 'lucide-react';

interface ScriptSelectorProps {
  options: readonly ScriptOption[];
  selectedScriptId: string;
  onSelect: (scriptId: string) => void;
  disabled?: boolean;
  variant?: 'card' | 'field';
}

function ScriptSelectControl({
  disabled,
  onSelect,
  options,
  selectedScriptId,
}: Omit<ScriptSelectorProps, 'variant'>) {
  return (
    <Select value={selectedScriptId} onValueChange={onSelect} disabled={disabled}>
      <SelectTrigger data-testid="select-script">
        <SelectValue placeholder="Choose a text..." />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            key={option.id}
            value={option.id}
            data-testid={`option-script-${option.id}`}
          >
            {option.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ScriptSelector({
  disabled = false,
  onSelect,
  options,
  selectedScriptId,
  variant = 'card',
}: ScriptSelectorProps) {
  if (variant === 'field') {
    return (
      <div className="space-y-2">
        <div className="space-y-1">
          <p className="text-sm font-medium">Rehearsal Text</p>
          <p className="text-sm text-muted-foreground">
            Choose the text to use for this session.
          </p>
        </div>
        <ScriptSelectControl
          disabled={disabled}
          onSelect={onSelect}
          options={options}
          selectedScriptId={selectedScriptId}
        />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <FileText className="w-5 h-5 text-primary" />
          Rehearsal Text
        </CardTitle>
        <CardDescription>Choose the text to practice.</CardDescription>
      </CardHeader>
      <CardContent>
        <ScriptSelectControl
          disabled={disabled}
          onSelect={onSelect}
          options={options}
          selectedScriptId={selectedScriptId}
        />
      </CardContent>
    </Card>
  );
}
