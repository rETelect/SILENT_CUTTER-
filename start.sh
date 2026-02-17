#!/bin/bash
# Kill any old processes on ports 8000 and 5173
kill -9 $(lsof -t -i:8000 2>/dev/null) 2>/dev/null
kill -9 $(lsof -t -i:5173 2>/dev/null) 2>/dev/null
sleep 1

echo "🚀 Starting Backend..."
cd /home/retelect/Desktop/newapp/backend
source venv/bin/activate
python main.py &
BACKEND_PID=$!

echo "🚀 Starting Frontend..."
cd /home/retelect/Desktop/newapp/frontend
npx vite --host &
FRONTEND_PID=$!

echo ""
echo "✅ Backend PID: $BACKEND_PID (http://localhost:8000)"
echo "✅ Frontend PID: $FRONTEND_PID (http://localhost:5173)"
echo ""
echo "Press Ctrl+C to stop both servers"

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT
wait
