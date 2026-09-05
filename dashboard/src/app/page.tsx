'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import TaskCard from '@/components/TaskCard';
import TaskForm from '@/components/TaskForm';
import StatusWidget from '@/components/StatusWidget';
import ActionButtons from '@/components/ActionButtons';
import ChatWindow from '@/components/ChatWindow';
import McpManager from '@/components/McpManager';
import LogsPanel from '@/components/LogsPanel';
import MemoryBrowser from '@/components/MemoryBrowser';
import AgentControl from '@/components/AgentControl';
import { Task, NovaStatus } from '@/lib/brutus';
import { requestNotificationPermission, registerServiceWorker, sendLocalNotification } from '@/lib/notifications';
import { useGateway } from '@/lib/useGateway';
import { getGatewayClient } from '@/lib/gateway';

type TabType = 'tasks' | 'actions' | 'mcp' | 'logs' | 'memory' | 'agents' | 'settings';

export default function Home() {
  const gateway = useGateway();
  const [localTasks, setLocalTasks] = useState<Task[]>([]);
  const [activeTab, setActiveTab] = useState<'all' | 'pending' | 'completed'>('all');
  const [activeSection, setActiveSection] = useState<TabType>('tasks');
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const clientRef = useRef(getGatewayClient());

  // Merge gateway tasks with local tasks
  const tasks: Task[] = gateway.status.connected
    ? (gateway.tasks as Task[])
    : localTasks;

  // Build status from gateway
  const status: NovaStatus = {
    timestamp: new Date().toISOString(),
    workspace: gateway.status.workspace || '/home/xaventra/clawd',
    services: {
      clawdbot: gateway.status.connected ? 'running' : 'offline',
      gateway: gateway.status.connected ? 'connected' : 'disconnected',
    },
    memoryFiles: [],
    taskQueue: {
      pending: tasks.filter(t => t.status === 'pending' || t.status === 'in_progress').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      failed: tasks.filter(t => t.status === 'failed').length,
    },
  };

  // Initial load
  useEffect(() => {
    const init = async () => {
      const registration = await registerServiceWorker();
      if (registration) {
        const hasPermission = await requestNotificationPermission();
        setNotificationsEnabled(hasPermission);
      }

      try {
        const res = await fetch('/api/tasks');
        const data = await res.json();
        if (Array.isArray(data)) {
          setLocalTasks(data);
        }
      } catch {
        console.log('Local API not available');
      }
    };

    init();
  }, []);

  // Filter tasks by tab
  const filteredTasks = tasks.filter(task => {
    if (activeTab === 'pending') return task.status === 'pending' || task.status === 'in_progress';
    if (activeTab === 'completed') return task.status === 'completed' || task.status === 'failed';
    return true;
  });

  // Handle new task creation
  const handleCreateTask = async (taskData: { description: string; priority: string; category: string }) => {
    setIsCreatingTask(true);

    try {
      if (gateway.status.connected) {
        await gateway.submitTask(taskData.description, {
          priority: taskData.priority,
          category: taskData.category,
        });
      } else {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(taskData),
        });

        if (res.ok) {
          const newTask = await res.json();
          setLocalTasks(prev => [newTask, ...prev]);
        }
      }

      if (notificationsEnabled) {
        sendLocalNotification('Task Created', taskData.description);
      }
    } catch (err) {
      console.error('Failed to create task:', err);
    }

    setIsCreatingTask(false);
  };

  // Handle task approval
  const handleApprove = async (id: string) => {
    if (gateway.status.connected) {
      await gateway.runAgent(`Approve task ${id}`);
    } else {
      await fetch(`/api/tasks/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      });
      setLocalTasks(prev => prev.map(task =>
        task.id === id ? { ...task, status: 'completed' as const } : task
      ));
    }
  };

  // Handle task cancellation
  const handleCancel = async (id: string) => {
    if (gateway.status.connected) {
      await gateway.runAgent(`Cancel task ${id}`);
    } else {
      await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
      setLocalTasks(prev => prev.filter(task => task.id !== id));
    }
  };

  // Enable notifications
  const handleEnableNotifications = async () => {
    const hasPermission = await requestNotificationPermission();
    setNotificationsEnabled(hasPermission);
    if (hasPermission) {
      sendLocalNotification('Notifications Enabled', 'You will receive task updates');
    }
  };

  const sectionIcons: Record<TabType, string> = {
    tasks: '📋',
    actions: '⚡',
    mcp: '🔌',
    logs: '📜',
    memory: '📁',
    agents: '🤖',
    settings: '⚙️',
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-950 to-slate-900 pb-20 lg:pb-0">
      {/* Header */}
      <header className="sticky top-0 z-50 backdrop-blur-lg bg-black/30 border-b border-purple-500/20">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold flex items-center gap-3">
              <span className="text-3xl">✨</span>
              <span className="bg-gradient-to-r from-purple-400 via-fuchsia-400 to-cyan-400 text-transparent bg-clip-text">
                Xaventra Legacy Dashboard
              </span>
            </h1>
            <div className="flex items-center gap-3">
              <span className={`text-xs px-2 py-1 rounded-full ${gateway.status.connected
                ? 'bg-green-500/20 text-green-400'
                : gateway.isConnecting
                  ? 'bg-yellow-500/20 text-yellow-400'
                  : 'bg-gray-500/20 text-gray-400'
                }`}>
                {gateway.status.connected ? '🔗 Gateway' : gateway.isConnecting ? '⏳ Connecting...' : '📡 Local'}
              </span>

              {!notificationsEnabled && (
                <button
                  onClick={handleEnableNotifications}
                  className="text-sm px-3 py-1 bg-blue-600/50 hover:bg-blue-600 rounded-lg transition-colors"
                >
                  🔔
                </button>
              )}
              <span className={`w-2 h-2 rounded-full ${gateway.status.connected ? 'bg-green-400 animate-pulse' : 'bg-yellow-400'
                }`}></span>
            </div>
          </div>
        </div>
      </header>

      {/* Section Tabs (Desktop) */}
      <div className="hidden lg:block max-w-6xl mx-auto px-4 py-2">
        <div className="flex gap-2 flex-wrap">
          {(['tasks', 'actions', 'logs', 'memory', 'agents', 'mcp'] as TabType[]).map(section => (
            <button
              key={section}
              onClick={() => setActiveSection(section)}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${activeSection === section
                ? 'bg-purple-600 text-white'
                : 'bg-white/5 text-gray-400 hover:bg-white/10'
                }`}
            >
              {sectionIcons[section]} {section.charAt(0).toUpperCase() + section.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-6">
        <aside role="note" className="mb-6 rounded-lg border border-amber-500/40 bg-amber-950/40 p-4 text-amber-100">
          Experimenteller Legacy-Client. Lokale Aufgaben und Gateway-Anzeigen sind keine verifizierten
          Xaventra-Missionen. Nutze Xaventra Desktop oder den Core-Control-Plane auf Port 3011 fuer den Betrieb.
        </aside>
        {/* Tasks Section */}
        {activeSection === 'tasks' && (
          <div className="grid lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1 space-y-6">
              <StatusWidget status={status} isLoading={gateway.isConnecting} error={null} />

              {gateway.status.nodes && gateway.status.nodes.length > 0 && (
                <div className="bg-white/5 rounded-2xl p-6 backdrop-blur-sm border border-white/10">
                  <h2 className="text-lg font-semibold mb-4">🖥️ Nodes</h2>
                  <div className="space-y-2">
                    {gateway.status.nodes.map(node => (
                      <div key={node.id} className="flex items-center justify-between bg-black/20 rounded-lg p-3">
                        <span className="text-sm">{node.name}</span>
                        <span className={`text-xs px-2 py-1 rounded ${node.status === 'online' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                          }`}>
                          {node.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <TaskForm onSubmit={handleCreateTask} isLoading={isCreatingTask} />
            </div>

            <div className="lg:col-span-2">
              <div className="flex gap-2 mb-4">
                {(['all', 'pending', 'completed'] as const).map(tab => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-4 py-2 rounded-lg font-medium transition-colors ${activeTab === tab
                      ? 'bg-purple-600 text-white'
                      : 'bg-white/5 text-gray-400 hover:bg-white/10'
                      }`}
                  >
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                    <span className="ml-2 text-sm opacity-70">
                      ({tasks.filter(t => {
                        if (tab === 'pending') return t.status === 'pending' || t.status === 'in_progress';
                        if (tab === 'completed') return t.status === 'completed' || t.status === 'failed';
                        return true;
                      }).length})
                    </span>
                  </button>
                ))}
              </div>

              <div className="space-y-4">
                {filteredTasks.length === 0 ? (
                  <div className="text-center py-12 text-gray-500">
                    <p className="text-4xl mb-2">📭</p>
                    <p>No tasks yet</p>
                  </div>
                ) : (
                  filteredTasks.map(task => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onApprove={handleApprove}
                      onCancel={handleCancel}
                    />
                  ))
                )}
              </div>

              {gateway.status.connected && gateway.logs.length > 0 && (
                <div className="mt-6 bg-black/30 rounded-xl p-4 border border-white/10">
                  <h3 className="text-sm font-medium text-gray-400 mb-2">Live Logs</h3>
                  <div className="font-mono text-xs text-green-400 max-h-32 overflow-y-auto">
                    {gateway.logs.slice(-10).map((log, i) => (
                      <div key={i}>{log}</div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Actions Section */}
        {activeSection === 'actions' && (
          <div className="max-w-2xl mx-auto">
            <ActionButtons
              client={clientRef.current}
              isConnected={gateway.status.connected}
            />
          </div>
        )}

        {/* MCP Section */}
        {activeSection === 'mcp' && (
          <div className="max-w-2xl mx-auto">
            <McpManager
              client={clientRef.current}
              isConnected={gateway.status.connected}
            />
          </div>
        )}

        {/* Logs Section */}
        {activeSection === 'logs' && (
          <div className="max-w-4xl mx-auto">
            <LogsPanel isConnected={gateway.status.connected} />
          </div>
        )}

        {/* Memory Section */}
        {activeSection === 'memory' && (
          <div className="max-w-4xl mx-auto">
            <MemoryBrowser isConnected={gateway.status.connected} />
          </div>
        )}

        {/* Agents Section */}
        {activeSection === 'agents' && (
          <div className="max-w-2xl mx-auto">
            <AgentControl
              client={clientRef.current}
              isConnected={gateway.status.connected}
            />
          </div>
        )}
      </main>

      {/* Chat Window */}
      <ChatWindow
        client={clientRef.current}
        isConnected={gateway.status.connected}
        sessionKey="main"
      />

      {/* Bottom Navigation (Mobile) */}
      <nav className="fixed bottom-0 left-0 right-0 lg:hidden backdrop-blur-lg bg-black/80 border-t border-white/10">
        <div className="flex justify-around py-3 pb-safe">
          {(['tasks', 'logs', 'agents', 'mcp'] as TabType[]).map(section => (
            <button
              key={section}
              onClick={() => setActiveSection(section)}
              className={`flex flex-col items-center transition-colors ${activeSection === section ? 'text-purple-400' : 'text-gray-400 hover:text-white'
                }`}
            >
              <span className="text-xl">{sectionIcons[section]}</span>
              <span className="text-xs mt-1">{section.charAt(0).toUpperCase() + section.slice(1)}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
