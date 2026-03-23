import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { User } from 'lucide-react';

interface CharacterSelectorProps {
  characters: string[];
  selectedCharacter: string | null;
  onSelect: (character: string) => void;
  disabled?: boolean;
}

export function CharacterSelector({ 
  characters, 
  selectedCharacter, 
  onSelect,
  disabled = false 
}: CharacterSelectorProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <User className="w-5 h-5 text-primary" />
          Your Character
        </CardTitle>
        <CardDescription>
          Select the character whose lines you want to practice
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Select
          value={selectedCharacter || ''}
          onValueChange={onSelect}
          disabled={disabled}
        >
          <SelectTrigger data-testid="select-character">
            <SelectValue placeholder="Choose your character..." />
          </SelectTrigger>
          <SelectContent>
            {characters.map((character) => (
              <SelectItem 
                key={character} 
                value={character}
                data-testid={`option-character-${character.toLowerCase().replace(/\s+/g, '-')}`}
              >
                {character}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardContent>
    </Card>
  );
}
