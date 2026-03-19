from __future__ import annotations

import math
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

try:
    from backend.model_engine import AnalysisResult, ModelEngine
except ModuleNotFoundError:
    from model_engine import AnalysisResult, ModelEngine


BASE_DIR = Path(__file__).resolve().parent
DATABASE_PATH = Path('/tmp/notifications.db') if os.getenv('VERCEL') else BASE_DIR / 'notifications.db'
MODEL_ENGINE = ModelEngine()

app = FastAPI(title='SAREIS API', version='1.1.0')
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)


class StudentInput(BaseModel):
    Student_ID: int
    Department: str = Field(..., min_length=2)
    Semester: int = Field(..., ge=1, le=12)
    Attendance_Percentage: float = Field(..., ge=0, le=100)
    Internal_Marks: float = Field(..., ge=0, le=100)
    Assignment_Marks: float = Field(..., ge=0, le=100)
    Quiz_Average: float = Field(..., ge=0, le=100)
    Backlogs_Count: int = Field(..., ge=0, le=10)
    CGPA: float = Field(..., ge=0, le=10)


class NotificationInput(BaseModel):
    student_id: int
    primary_cause: str
    suggested_action: str
    faculty_name: str = 'Class Advisor'


def get_connection() -> sqlite3.Connection:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def serialize_notification(row: sqlite3.Row) -> dict[str, Any]:
    return {
        'id': row['id'],
        'student_id': row['student_id'],
        'primary_cause': row['primary_cause'],
        'suggested_action': row['suggested_action'],
        'faculty_name': row['faculty_name'],
        'created_at': row['created_at'],
    }


def ensure_database() -> None:
    with closing(get_connection()) as connection:
        connection.execute(
            '''
            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_id INTEGER NOT NULL,
                primary_cause TEXT NOT NULL,
                suggested_action TEXT NOT NULL,
                faculty_name TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            '''
        )
        connection.commit()


@app.on_event('startup')
def startup_event() -> None:
    ensure_database()


@app.get('/health')
def healthcheck() -> dict[str, str]:
    return {'status': 'ok'}


@app.post('/analyze-risk')
def analyze_risk(payload: StudentInput) -> dict[str, Any]:
    result: AnalysisResult = MODEL_ENGINE.analyze_student(payload.model_dump())
    return result.to_dict()


@app.get('/students')
def get_students(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=25),
    search: str | None = Query(default=None),
    department: str | None = Query(default=None),
    sort_by: str = Query(default='risk_priority'),
    sort_dir: str = Query(default='asc'),
) -> dict[str, Any]:
    students = MODEL_ENGINE.list_student_analysis()

    if search:
        search_term = search.strip().lower()
        students = [
            student for student in students
            if search_term in str(student['Student_ID']).lower()
            or search_term in student['Department'].lower()
            or search_term in student['primary_cause'].lower()
        ]

    if department and department.lower() != 'all':
        students = [student for student in students if student['Department'].lower() == department.lower()]

    reverse = sort_dir.lower() == 'desc'
    risk_order = {'High': 0, 'Medium': 1, 'Low': 2}
    sort_map = {
        'student_id': lambda item: item['Student_ID'],
        'department': lambda item: item['Department'],
        'cgpa': lambda item: item['CGPA'],
        'score': lambda item: item['score'],
        'risk_band': lambda item: risk_order[item['risk_band']],
        'risk_priority': lambda item: (risk_order[item['risk_band']], item['score'], item['Student_ID']),
    }
    sort_key = sort_map.get(sort_by, sort_map['risk_priority'])
    students = sorted(students, key=sort_key, reverse=reverse if sort_by != 'risk_priority' else False)

    total = len(students)
    total_pages = max(1, math.ceil(total / page_size))
    page = min(page, total_pages)
    start = (page - 1) * page_size
    end = start + page_size

    return {
        'students': students[start:end],
        'total': total,
        'page': page,
        'page_size': page_size,
        'total_pages': total_pages,
    }


@app.get('/students/{student_id}')
def get_student(student_id: int) -> dict[str, Any]:
    for student in MODEL_ENGINE.list_student_analysis():
        if student['Student_ID'] == student_id:
            return student
    raise HTTPException(status_code=404, detail='Student not found')


@app.get('/class-analytics')
def get_class_analytics() -> dict[str, Any]:
    return MODEL_ENGINE.class_summary()


@app.post('/notifications')
def create_notification(payload: NotificationInput) -> dict[str, Any]:
    timestamp = datetime.now(timezone.utc).isoformat()

    with closing(get_connection()) as connection:
        cursor = connection.execute(
            '''
            INSERT INTO notifications (student_id, primary_cause, suggested_action, faculty_name, created_at)
            VALUES (?, ?, ?, ?, ?)
            ''',
            (
                payload.student_id,
                payload.primary_cause,
                payload.suggested_action,
                payload.faculty_name,
                timestamp,
            ),
        )
        notification_id = cursor.lastrowid
        connection.commit()
        row = connection.execute(
            'SELECT * FROM notifications WHERE id = ?',
            (notification_id,),
        ).fetchone()

    return {
        'message': 'Intervention recorded successfully.',
        'notification': serialize_notification(row),
    }


@app.get('/notifications')
def get_notifications(student_id: int | None = None) -> dict[str, list[dict[str, Any]]]:
    query = 'SELECT * FROM notifications'
    params: tuple[Any, ...] = ()

    if student_id is not None:
        query += ' WHERE student_id = ?'
        params = (student_id,)

    query += ' ORDER BY datetime(created_at) DESC'

    with closing(get_connection()) as connection:
        rows = connection.execute(query, params).fetchall()

    return {'notifications': [serialize_notification(row) for row in rows]}


@app.get('/model-metrics')
def get_model_metrics() -> dict[str, Any]:
    return MODEL_ENGINE.get_model_metrics()


@app.get('/dashboard-metrics')
def get_dashboard_metrics() -> dict[str, Any]:
    students = MODEL_ENGINE.list_student_analysis()
    notifications = get_notifications()['notifications']

    return {
        'total_students': len(students),
        'high_risk_count': sum(1 for student in students if student['risk_band'] == 'High'),
        'medium_risk_count': sum(1 for student in students if student['risk_band'] == 'Medium'),
        'low_risk_count': sum(1 for student in students if student['risk_band'] == 'Low'),
        'red_count': sum(1 for student in students if student['risk_level'] == 'Red'),
        'orange_count': sum(1 for student in students if student['risk_level'] == 'Orange'),
        'green_count': sum(1 for student in students if student['risk_level'] == 'Green'),
        'intervention_count': len(notifications),
        'average_score': round(sum(student['score'] for student in students) / len(students), 2),
        'students_needing_follow_up': sum(1 for student in students if student['risk_band'] != 'Low'),
    }

