from __future__ import annotations

import uuid
from pathlib import Path

from sqlalchemy import Column, ForeignKey, String, Text, UniqueConstraint, create_engine
from sqlalchemy.orm import DeclarativeBase, Session, relationship, sessionmaker

_DB_PATH = Path(__file__).resolve().parent.parent / "zeta_demo.db"
_DATABASE_URL = f"sqlite:///{_DB_PATH}"

engine = create_engine(_DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def _uuid() -> str:
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    pass


class Project(Base):
    __tablename__ = "projects"

    id = Column(String, primary_key=True, default=_uuid)
    name = Column(String, nullable=False)

    documents = relationship("Document", back_populates="project", cascade="all, delete-orphan")
    notation_nodes = relationship("NotationNode", back_populates="project", cascade="all, delete-orphan")


class Document(Base):
    __tablename__ = "documents"

    id = Column(String, primary_key=True, default=_uuid)
    project_id = Column(String, ForeignKey("projects.id"), nullable=False)
    file_path = Column(String, nullable=False)
    content = Column(Text, nullable=False, default="")

    project = relationship("Project", back_populates="documents")

    __table_args__ = (UniqueConstraint("project_id", "file_path", name="uq_doc_path"),)


class NotationNode(Base):
    __tablename__ = "notation_nodes"

    id = Column(String, primary_key=True, default=_uuid)
    project_id = Column(String, ForeignKey("projects.id"), nullable=False)
    symbol = Column(String, nullable=False)
    latex_type = Column(String, nullable=False, default="unknown")
    lean_type = Column(String, nullable=False, default="unknown")
    defined_in = Column(String, nullable=False, default="")
    context_text = Column(Text, nullable=False, default="")

    project = relationship("Project", back_populates="notation_nodes")

    __table_args__ = (UniqueConstraint("project_id", "symbol", "defined_in", name="uq_notation_symbol_file"),)


def init_db() -> None:
    Base.metadata.create_all(bind=engine)


def get_db() -> Session:
    return SessionLocal()


DEMO_PROJECT_ID = "demo-project-001"


def ensure_demo_project() -> str:
    db = get_db()
    try:
        existing = db.query(Project).filter(Project.id == DEMO_PROJECT_ID).first()
        if not existing:
            db.add(Project(id=DEMO_PROJECT_ID, name="Demo Project"))
            db.commit()
        return DEMO_PROJECT_ID
    finally:
        db.close()
