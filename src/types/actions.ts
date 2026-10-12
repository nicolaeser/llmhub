export type ActionFail = {
  ok: false;
  error: string;
  message: string;
};

export type ActionLoader<T> = () => Promise<T | ActionFail>;

export type ActionSnapshot<T> = {
  data: T | null;
  error: string | null;
  pending: boolean;
};

export type LoadStatus = {
  error: string | null;
  pending: boolean;
  reload: () => void;
};

export type ActionDataUpdate<T> = T | ((current: T) => T);

export type ActionData<T> = ActionSnapshot<T> &
  LoadStatus & {
    reloadWith: (next: ActionLoader<T>) => void;
    setData: (update: ActionDataUpdate<T>) => void;
  };
