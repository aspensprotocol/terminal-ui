interface MessageDisplayProps {
  error?: string | null;
  success?: string | null;
}

export function MessageDisplay({ error, success }: MessageDisplayProps) {
  if (!error && !success) {
    return null;
  }

  return (
    <>
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-md p-2 text-red-600 text-xs font-medium">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-500/10 border border-green-500/30 rounded-md p-2 text-green-600 text-xs font-medium">
          {success}
        </div>
      )}
    </>
  );
}
